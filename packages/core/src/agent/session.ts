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
}

/** 宿主注入的审批回调：返回用户是否批准。M1 由 Electron Main 弹给 Renderer。 */
export type ApprovalHandler = (request: {
  requestId: string
  toolName: string
  input: unknown
  diff?: string
}) => Promise<boolean>

/**
 * Agent 会话（M1-c：完整工具循环）。
 * 多轮循环交给 AI SDK 的 stopWhen 机制（模型不再发工具调用即停止）；
 * 审批在工具 execute 内 await，批准前不落盘。
 */
export class AgentSession {
  private messages: ModelMessage[] = []
  private options: AgentSessionOptions

  constructor(options: AgentSessionOptions) {
    this.options = options
  }

  setModel(model: ModelEntry, providerConfig: ProviderConfig): void {
    this.options = { ...this.options, model, providerConfig }
  }

  /** 把 WhyCode 工具定义包装成 AI SDK ToolSet；审批与事件都在 execute 内处理 */
  private buildToolSet(
    emit: (event: CoreEvent) => void,
    requestApproval: ApprovalHandler,
    abortSignal: AbortSignal,
  ): ToolSet {
    const toolCtx: ToolContext = {
      projectDir: this.options.promptContext.projectDir,
      abortSignal,
    }
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
          emit({
            type: 'tool-start',
            toolUseId: toolCallId,
            toolName: def.name,
            input: parsed.data,
          })

          if (def.needsApproval(parsed.data)) {
            emit({ type: 'agent-status', status: 'waiting-approval' })
            const diff = await def
              .renderDiff?.(parsed.data, toolCtx)
              .catch(() => undefined)
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

  /** 处理一条用户消息。事件经 emit 回调吐出（工具审批期间也能持续发事件）。 */
  async run(
    userText: string,
    abortSignal: AbortSignal,
    emit: (event: CoreEvent) => void,
    requestApproval: ApprovalHandler,
  ): Promise<void> {
    const turnId = crypto.randomUUID()
    this.messages.push({ role: 'user', content: userText })

    emit({ type: 'turn-start', turnId })
    emit({ type: 'agent-status', status: 'working' })

    let stopReason: StopReason = 'completed'
    const usage: UsageInfo = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      costUsd: 0,
    }

    try {
      const result = streamText({
        model: this.options.model.create(this.options.providerConfig),
        system: buildSystemPrompt(this.options.promptContext),
        messages: this.messages,
        tools: this.buildToolSet(emit, requestApproval, abortSignal),
        stopWhen: stepCountIs(MAX_STEPS),
        providerOptions: this.options.model.providerOptions,
        abortSignal,
      })

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
          case 'finish':
            usage.inputTokens = part.totalUsage.inputTokens ?? 0
            usage.outputTokens = part.totalUsage.outputTokens ?? 0
            usage.cachedInputTokens =
              part.totalUsage.inputTokenDetails.cacheReadTokens ?? 0
            break
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          case 'abort':
            stopReason = 'aborted'
            break
          default:
            break
        }
      }

      if (thinkingStartedAt !== null) {
        emit({ type: 'thinking-end', durationMs: Date.now() - thinkingStartedAt })
      }

      // 把本轮完整消息（含 tool call/result）并入历史，供下一轮使用
      const response = await result.response
      this.messages.push(...response.messages)
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

    emit({ type: 'turn-end', turnId, usage, stopReason })
    emit({ type: 'agent-status', status: stopReason === 'error' ? 'error' : 'idle' })
  }
}
