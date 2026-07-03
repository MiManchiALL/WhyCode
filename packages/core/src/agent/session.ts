import { stepCountIs, streamText, tool as aiTool, type ModelMessage, type ToolSet } from 'ai'
import type { CoreEvent, StopReason, UsageInfo } from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import type { ToolContext, ToolDefinition } from '../tools/tool.ts'
import { BUILTIN_TOOLS } from '../tools/registry.ts'
import { buildSystemPrompt, type PromptContext } from '../prompts/system.ts'

const MAX_STEPS = 25

export interface AgentSessionOptions {
  model: ModelEntry
  providerConfig: ProviderConfig
  promptContext: PromptContext
  /** 事件出口（宿主注入） */
  emit: (event: CoreEvent) => void
  /** 审批回调（宿主注入）：返回用户是否批准 */
  requestApproval: ApprovalHandler
}

export type ApprovalHandler = (request: {
  requestId: string
  toolName: string
  input: unknown
  diff?: string
}) => Promise<boolean>

interface QueuedMessage {
  id: string
  text: string
}

/**
 * Agent 会话（M2-a：自持外层循环 + steering 消息队列）。
 *
 * 循环架构（对齐文档二 §5.1 / 文档一 §3.1）：外层循环每次 streamText 只跑一步
 * （stepCountIs(1)，工具仍由 AI SDK 在步内执行），消息数组由本类维护——
 * 步骤间因此可以注入排队的用户消息（steering）、后续可做压缩改写（M2-d）。
 */
export class AgentSession {
  private messages: ModelMessage[] = []
  private queue: QueuedMessage[] = []
  private running = false
  private options: AgentSessionOptions

  constructor(options: AgentSessionOptions) {
    this.options = options
  }

  setModel(model: ModelEntry, providerConfig: ProviderConfig): void {
    this.options = { ...this.options, model, providerConfig }
  }

  get isRunning(): boolean {
    return this.running
  }

  /**
   * 用户消息统一入口：空闲时开始新 turn；运行中则排队（steering），
   * 由循环在步骤间注入或 turn 结束后续跑。
   */
  handleUserMessage(text: string, abortSignal: AbortSignal): Promise<void> | void {
    if (this.running) {
      const item = { id: crypto.randomUUID(), text }
      this.queue.push(item)
      this.options.emit({ type: 'message-queued', id: item.id, text })
      return
    }
    return this.runLoop([{ role: 'user', content: text }], abortSignal)
  }

  /** 中断收尾：排队消息弹回输入框，不静默丢弃 */
  onAborted(): void {
    if (this.queue.length > 0) {
      const text = this.queue.map((q) => q.text).join('\n')
      this.queue = []
      this.options.emit({ type: 'queue-restored', text })
    }
  }

  /** 取出全部排队消息（清空队列） */
  private drainQueue(): QueuedMessage[] {
    const drained = this.queue
    this.queue = []
    return drained
  }

  /** 步骤间注入：包 system-reminder + 必须回应的前导语 */
  private injectQueuedMidTurn(): void {
    for (const item of this.drainQueue()) {
      this.messages.push({
        role: 'user',
        content: [
          '<system-reminder>',
          '用户在你工作时发来了新消息：',
          item.text,
          '完成当前任务后必须回应这条消息，不要忽略它。若它改变了任务方向，优先遵循它。',
          '</system-reminder>',
        ].join('\n'),
      })
      this.options.emit({ type: 'message-injected', id: item.id, text: item.text })
    }
  }

  /** 外层循环：turn（含 steering 续跑）→ step → 工具，直到无工具调用且队列为空 */
  private async runLoop(
    initialMessages: ModelMessage[],
    abortSignal: AbortSignal,
  ): Promise<void> {
    const { emit } = this.options
    this.running = true
    const turnId = crypto.randomUUID()
    this.messages.push(...initialMessages)

    emit({ type: 'turn-start', turnId })
    emit({ type: 'agent-status', status: 'working' })

    let stopReason: StopReason = 'completed'
    const usage: UsageInfo = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }

    try {
      let steps = 0
      while (steps < MAX_STEPS) {
        steps++
        const hadToolCalls = await this.runOneStep(usage, abortSignal)
        if (abortSignal.aborted) {
          stopReason = 'aborted'
          break
        }
        // 注入点：本步工具结果已收齐、下一次模型请求前（文档一 §3.1）
        if (this.queue.length > 0) {
          this.injectQueuedMidTurn()
          continue // 有新消息注入时，即使模型没调工具也要续一步来回应
        }
        if (!hadToolCalls) break
      }
      if (steps >= MAX_STEPS) stopReason = 'max-turns'
    } catch (error) {
      if (abortSignal.aborted) {
        stopReason = 'aborted'
      } else {
        stopReason = 'error'
        emit({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          recoverable: true,
        })
      }
    }

    this.running = false
    if (stopReason === 'aborted') this.onAborted()

    emit({ type: 'turn-end', turnId, usage, stopReason })

    // turn 正常结束后队列仍有剩余（极端时序）→ 作为新 turn 续跑
    if (stopReason === 'completed' && this.queue.length > 0) {
      const drained = this.drainQueue()
      for (const item of drained) {
        emit({ type: 'message-injected', id: item.id, text: item.text })
      }
      return this.runLoop(
        drained.map((q) => ({ role: 'user' as const, content: q.text })),
        abortSignal,
      )
    }

    emit({ type: 'agent-status', status: stopReason === 'error' ? 'error' : 'idle' })
  }

  /** 单步：一次模型调用 + 步内工具执行；返回是否发生了工具调用 */
  private async runOneStep(usage: UsageInfo, abortSignal: AbortSignal): Promise<boolean> {
    const { emit } = this.options
    const result = streamText({
      model: this.options.model.create(this.options.providerConfig),
      system: buildSystemPrompt(this.options.promptContext),
      messages: this.messages,
      tools: this.buildToolSet(abortSignal),
      stopWhen: stepCountIs(1),
      providerOptions: this.options.model.providerOptions,
      abortSignal,
    })

    let hadToolCalls = false
    let thinkingStartedAt: number | null = null

    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'reasoning-delta': {
          if (thinkingStartedAt === null) {
            thinkingStartedAt = Date.now()
            emit({ type: 'agent-status', status: 'thinking' })
          }
          emit({ type: 'thinking-delta', text: part.text })
          break
        }
        case 'reasoning-end': {
          if (thinkingStartedAt !== null) {
            emit({ type: 'thinking-end', durationMs: Date.now() - thinkingStartedAt })
            emit({ type: 'agent-status', status: 'working' })
            thinkingStartedAt = null
          }
          break
        }
        case 'text-delta':
          emit({ type: 'text-delta', text: part.text })
          break
        case 'tool-call':
          hadToolCalls = true
          break
        case 'finish':
          usage.inputTokens += part.totalUsage.inputTokens ?? 0
          usage.outputTokens += part.totalUsage.outputTokens ?? 0
          usage.cachedInputTokens += part.totalUsage.inputTokenDetails.cacheReadTokens ?? 0
          break
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error))
        default:
          break
      }
    }

    if (thinkingStartedAt !== null) {
      emit({ type: 'thinking-end', durationMs: Date.now() - thinkingStartedAt })
    }

    // 本步产生的消息（assistant + tool 结果）并入历史
    const response = await result.response
    this.messages.push(...response.messages)
    return hadToolCalls
  }

  /** 把 WhyCode 工具定义包装成 AI SDK ToolSet；纯聊天模式（无项目目录）返回空集 */
  private buildToolSet(abortSignal: AbortSignal): ToolSet | undefined {
    const projectDir = this.options.promptContext.projectDir
    if (!projectDir) return undefined

    const { emit, requestApproval } = this.options
    const toolCtx: ToolContext = { projectDir, abortSignal }
    const toolSet: ToolSet = {}
    for (const def of BUILTIN_TOOLS as ToolDefinition[]) {
      toolSet[def.name] = aiTool({
        description: def.prompt,
        inputSchema: def.inputSchema,
        execute: async (input: unknown, { toolCallId }) => {
          const parsed = def.inputSchema.safeParse(input)
          if (!parsed.success) {
            const msg = `参数校验失败：${parsed.error.message}`
            emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
            return msg
          }
          emit({ type: 'tool-start', toolUseId: toolCallId, toolName: def.name, input: parsed.data })

          if (def.needsApproval(parsed.data)) {
            emit({ type: 'agent-status', status: 'waiting-approval' })
            const diff = await def.renderDiff?.(parsed.data, toolCtx).catch(() => undefined)
            const approved = await requestApproval({
              requestId: toolCallId,
              toolName: def.name,
              input: parsed.data,
              diff,
            })
            emit({ type: 'agent-status', status: 'working' })
            if (!approved) {
              const msg = '用户拒绝了此操作'
              emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
              return msg
            }
          }

          try {
            const result = await def.execute(parsed.data, {
              ...toolCtx,
              onProgress: (output) =>
                emit({ type: 'tool-progress', toolUseId: toolCallId, output }),
            })
            emit({
              type: 'tool-end',
              toolUseId: toolCallId,
              result: result.data,
              isError: result.isError,
            })
            return result.data
          } catch (error) {
            const msg = `工具执行出错：${error instanceof Error ? error.message : String(error)}`
            emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
            return msg
          }
        },
      })
    }
    return toolSet
  }
}
