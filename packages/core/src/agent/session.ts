import { stepCountIs, streamText, tool as aiTool, type ModelMessage, type ToolSet } from 'ai'
import type { CoreEvent, StopReason, UsageInfo } from '../events.ts'
import type { ModelEntry, ProviderConfig } from '../providers/registry.ts'
import type { ToolContext, ToolDefinition } from '../tools/tool.ts'
import { BUILTIN_TOOLS } from '../tools/registry.ts'
import { buildSystemPrompt, type PromptContext } from '../prompts/system.ts'
import { checkToolPermission } from '../permissions/engine.ts'
import { CheckpointManager } from '../checkpoints/manager.ts'
import { autoCompactThreshold, estimateContextTokens, type TokenBaseline } from '../context/tokens.ts'
import { microcompact } from '../context/microcompact.ts'
import { compactMessages } from '../context/compact.ts'
import type { SessionRecorder } from '../session/types.ts'
import { READ_FILE_TOOL_NAME } from '../tools/read-file/index.ts'
import { resolveAllowed } from '../tools/fs-utils.ts'
import {
  createPermissionContext,
  type ApprovalSuggestion,
  type PermissionContext,
  type PermissionMode,
} from '../permissions/types.ts'

const MAX_STEPS = 40
const FINALIZATION_RESERVE_STEPS = 5
const MAX_COMPACT_FAILURES = 3

export interface AgentSessionOptions {
  model: ModelEntry
  providerConfig: ProviderConfig
  promptContext: PromptContext
  /** 检查点存储根目录（宿主注入，如 Electron userData/checkpoints）；不传则禁用检查点 */
  checkpointStorageDir?: string
  /** 额外注入的工具（M3：SubmitProtocolOutput 等协商工具） */
  extraTools?: ToolDefinition[]
  /** M4：稳定边界会话记录器；不传则保持纯内存会话 */
  sessionRecorder?: SessionRecorder
  /** 事件出口（宿主注入） */
  emit: (event: CoreEvent) => void
  /** 审批回调（宿主注入）：返回用户的决定 */
  requestApproval: ApprovalHandler
}

export interface ApprovalRequest {
  requestId: string
  toolName: string
  input: unknown
  /** 为什么需要审批（权限引擎给出） */
  reason: string
  diff?: string
  /** 批准时可勾选的「记住」建议（add-dir / allow-tool），无建议则只能单次批准 */
  suggestion?: ApprovalSuggestion
}

export interface ApprovalResponse {
  approved: boolean
  /** true = 采纳 suggestion（本会话记住） */
  remember?: boolean
}

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalResponse>

interface QueuedMessage {
  id: string
  text: string
}

interface StepResult {
  hadToolCalls: boolean
  endedByTool: boolean
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
  /** 当前步骤的中止器：turn 级取消与 urgent 插话都经由它，用 reason 区分意图 */
  private currentStepAbort: AbortController | null = null
  private options: AgentSessionOptions
  /** 权限上下文（mode / 额外授权目录 / 会话内记住的工具） */
  private permissions: PermissionContext
  private checkpoints: CheckpointManager | null = null
  private checkpointDisabledNotified = false
  /** toolUseId → 快照记录；对话回滚锚定 turn 起点（含触发指令），保证「从没发生过」语义 */
  private checkpointIndex = new Map<
    string,
    { hash: string; turnId: string; turnStartLen: number }
  >()
  /** turnId → 该 turn 第一个快照 hash（文件+对话回滚时文件也回到 turn 起点，与对话一致） */
  private firstCheckpointOfTurn = new Map<string, string>()
  /** 当前 turn 信息（快照记录用） */
  private activeTurn: { id: string; startLen: number } | null = null
  /** 当前操作（turn 或压缩）的中止器，session 自管 */
  private opAbort: AbortController | null = null
  /** 手动压缩进行中（此间用户消息排队，压缩后接续） */
  private compacting = false
  /** token 计量基线（最后一次 API usage）；改写历史后置 null 全量重估 */
  private tokenBaseline: TokenBaseline | null = null
  /** 压缩熔断：连续失败 3 次后本会话停止尝试，成功清零 */
  private compactFailures = 0
  /** 会话内读过的文件（压缩后重注入用）：绝对路径 → 最后读取时间 */
  private recentReadFiles = new Map<string, number>()
  /** 持久化失败后本会话降级内存模式，避免每个 step 重复报错 */
  private persistenceFailed = false
  /** 正式协议回合只通过结构化事件展示结果，避免内部候选文本混入最终回答。 */
  private protocolRound = false

  constructor(options: AgentSessionOptions) {
    this.options = options
    this.messages = [...(options.sessionRecorder?.initialMessages ?? [])]
    this.permissions = createPermissionContext(
      options.promptContext.projectDir,
      options.promptContext.discussion,
    )
    // 讨论阶段的会话不做检查点（不写项目，无需快照）
    if (
      options.checkpointStorageDir &&
      options.promptContext.projectDir &&
      !options.promptContext.discussion
    ) {
      this.checkpoints = new CheckpointManager(
        options.promptContext.projectDir,
        options.checkpointStorageDir,
      )
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.permissions.mode = mode
  }

  get permissionMode(): PermissionMode {
    return this.permissions.mode
  }

  setModel(model: ModelEntry, providerConfig: ProviderConfig): void {
    this.options = { ...this.options, model, providerConfig }
    void this.persist((recorder) => recorder.updateModel(model.id))
  }

  /** 替换注入的额外工具（M3：每轮协商换入该轮的协议输出工具） */
  setExtraTools(tools: ToolDefinition[]): void {
    this.options = { ...this.options, extraTools: tools }
  }

  setProtocolRound(active: boolean): void {
    this.protocolRound = active
  }

  /**
   * 切换讨论档（M3）：进入协商讨论阶段时禁写项目、写实验限 scratch；null = 恢复正常执行档。
   * scratch 目录保留在 additionalDirs 中，执行阶段 Main 仍可读取实验产物。
   */
  setDiscussion(discussion: { agentId: 'Main' | 'B' | 'C'; scratchDir: string } | null): void {
    this.options = {
      ...this.options,
      promptContext: { ...this.options.promptContext, discussion: discussion ?? undefined },
    }
    this.permissions.discussion = discussion ? { scratchDir: discussion.scratchDir } : undefined
    if (discussion && !this.permissions.additionalDirs.includes(discussion.scratchDir)) {
      this.permissions.additionalDirs.push(discussion.scratchDir)
    }
  }

  get isRunning(): boolean {
    return this.running
  }

  /** 协商事务锚点：返回隔离副本，失败/取消时由 Orchestrator 恢复。 */
  captureMessageSnapshot(): ModelMessage[] {
    return structuredClone(this.messages)
  }

  /** 仅允许在回合结束后恢复，持久化回滚由共识任务终点统一提交。 */
  restoreMessageSnapshot(messages: ModelMessage[]): void {
    if (this.running || this.compacting) throw new Error('Agent 工作中，不能恢复消息快照')
    this.messages = structuredClone(messages)
    this.tokenBaseline = null
  }

  /**
   * 用户消息统一入口：空闲时开始新 turn；运行中/压缩中则排队（steering）。
   * urgent = 打断当前步骤立即注入（Claude Code 的 now 语义），默认等当前步骤结束（next 语义）。
   */
  handleUserMessage(text: string, urgent = false): Promise<StopReason> | void {
    if (this.running || this.compacting) {
      const item = { id: crypto.randomUUID(), text }
      this.queue.push(item)
      this.options.emit({ type: 'message-queued', id: item.id, text })
      if (urgent && this.running) {
        // reason='interrupt'：步骤被静默放弃（不产生错误），循环随即注入排队消息
        this.currentStepAbort?.abort('interrupt')
      }
      return
    }
    return this.startTurn([{ role: 'user', content: text }])
  }

  /** 开启新 turn：中止控制器由 session 自管（含续跑/压缩后接续场景） */
  private startTurn(initialMessages: ModelMessage[]): Promise<StopReason> {
    this.opAbort = new AbortController()
    return this.runLoop(initialMessages, this.opAbort.signal)
  }

  /** 用户点「停止」：中止当前 turn 或压缩 */
  abort(): void {
    this.opAbort?.abort('user-cancel')
  }

  /** 中断收尾：排队消息弹回输入框，不静默丢弃 */
  private onAborted(): void {
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
  private async injectQueuedMidTurn(): Promise<void> {
    const injected: ModelMessage[] = []
    for (const item of this.drainQueue()) {
      const message: ModelMessage = {
        role: 'user',
        content: [
          '<system-reminder>',
          '用户在你工作时发来了新消息：',
          item.text,
          '完成当前任务后必须回应这条消息，不要忽略它。若它改变了任务方向，优先遵循它。',
          '</system-reminder>',
        ].join('\n'),
      }
      this.messages.push(message)
      injected.push(message)
      this.options.emit({ type: 'message-injected', id: item.id, text: item.text })
    }
    if (injected.length > 0 && this.activeTurn) {
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, injected))
    }
  }

  /** 外层循环：turn（含 steering 续跑）→ step → 工具，直到无工具调用且队列为空 */
  private async runLoop(
    initialMessages: ModelMessage[],
    abortSignal: AbortSignal,
  ): Promise<StopReason> {
    const { emit } = this.options
    this.running = true
    const turnId = crypto.randomUUID()
    // turn 起点先于 initialMessages 入栈：对话回滚锚定这里，触发指令一并移除
    this.activeTurn = { id: turnId, startLen: this.messages.length }
    this.messages.push(...initialMessages)
    await this.persist((recorder) => recorder.recordTurnStart(turnId, initialMessages))

    emit({ type: 'turn-start', turnId })
    emit({ type: 'agent-status', status: 'working' })

    let stopReason: StopReason = 'completed'
    let endedByTool = false
    const usage: UsageInfo = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }

    try {
      let steps = 0
      let finishedNaturally = false
      while (steps < MAX_STEPS) {
        steps++
        if (steps === MAX_STEPS - FINALIZATION_RESERVE_STEPS) {
          await this.injectStepLimitReminder()
        }
        await this.compactIfNeeded(abortSignal)
        const step = await this.runOneStep(usage, abortSignal)
        if (abortSignal.aborted) {
          stopReason = 'aborted'
          break
        }
        if (step.endedByTool) {
          endedByTool = true
          break
        }
        // 注入点：本步工具结果已收齐、下一次模型请求前（文档一 §3.1）
        if (this.queue.length > 0) {
          await this.injectQueuedMidTurn()
          continue // 有新消息注入时，即使模型没调工具也要续一步来回应
        }
        if (!step.hadToolCalls) {
          finishedNaturally = true
          break
        }
      }
      if (
        stopReason === 'completed' &&
        steps >= MAX_STEPS &&
        !endedByTool &&
        !finishedNaturally
      ) {
        stopReason = 'max-turns'
        emit({
          type: 'error',
          message: `当前回合已达到 ${MAX_STEPS} 步工具循环安全上限，可能尚未完成。请发送“继续”让 Agent 基于现有上下文接着处理。`,
          recoverable: true,
        })
      }
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
    await this.persist((recorder) => recorder.recordTurnEnd(turnId, stopReason))

    emit({ type: 'turn-end', turnId, usage, stopReason })

    // turn 正常结束后队列仍有剩余（极端时序）→ 作为新 turn 续跑
    if (stopReason === 'completed' && !endedByTool && this.queue.length > 0) {
      const drained = this.drainQueue()
      for (const item of drained) {
        emit({ type: 'message-injected', id: item.id, text: item.text })
      }
      return this.startTurn(drained.map((q) => ({ role: 'user' as const, content: q.text })))
    }

    emit({ type: 'agent-status', status: stopReason === 'error' ? 'error' : 'idle' })
    return stopReason
  }

  /** 给模型预留收尾窗口，避免一直扩展探索直到安全上限才突然停止。 */
  private async injectStepLimitReminder(): Promise<void> {
    const reminder: ModelMessage = {
      role: 'user',
      content: [
        '<system-reminder>',
        `当前回合还剩 ${FINALIZATION_RESERVE_STEPS + 1} 次模型请求即达到工具循环安全上限。`,
        '请停止扩展性探索，只做必要收尾；能完成时立即给出完整结论，协议阶段则立即提交正式协议输出。',
        '</system-reminder>',
      ].join('\n'),
    }
    this.messages.push(reminder)
    if (this.activeTurn) {
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, [reminder]))
    }
  }

  /** 手动压缩（用户主动触发，不看阈值）：直接走全量摘要；期间用户消息排队，完成后接续 */
  async compactNow(): Promise<void> {
    const { emit } = this.options
    if (this.running || this.compacting) {
      emit({ type: 'error', message: 'Agent 工作中，请先停止再压缩', recoverable: true })
      return
    }
    if (this.messages.length < 2) {
      emit({ type: 'error', message: '对话太短，无需压缩', recoverable: true })
      return
    }
    this.compacting = true
    this.opAbort = new AbortController()
    const signal = this.opAbort.signal
    const preTokens = estimateContextTokens(this.messages, this.tokenBaseline)
    emit({ type: 'agent-status', status: 'working' })
    try {
      const result = await compactMessages(
        this.options.model.create(this.options.providerConfig),
        this.messages,
        [...this.recentReadFiles].map(([path, readAt]) => ({ path, readAt })),
        signal,
      )
      this.messages = result.messages
      await this.persist((recorder) => recorder.recordSnapshot('compact', this.messages))
      this.tokenBaseline = null
      this.compactFailures = 0
      for (const [key, rec] of this.checkpointIndex) {
        this.checkpointIndex.set(key, { ...rec, turnStartLen: -1 })
      }
      emit({
        type: 'context-compacted',
        level: 'full',
        preTokens,
        postTokens: estimateContextTokens(this.messages, null),
      })
    } catch (error) {
      emit({
        type: 'error',
        message: signal.aborted
          ? '压缩已取消'
          : `压缩失败：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    }
    this.compacting = false
    emit({ type: 'agent-status', status: 'idle' })

    // 压缩期间排队的消息：取消则弹回输入框；正常结束则在新上下文上接续为新 turn
    if (signal.aborted) {
      this.onAborted()
    } else if (this.queue.length > 0) {
      const drained = this.drainQueue()
      for (const item of drained) {
        emit({ type: 'message-injected', id: item.id, text: item.text })
      }
      await this.startTurn(drained.map((q) => ({ role: 'user' as const, content: q.text })))
    }
  }

  /**
   * 上下文压缩检查（每次模型请求前，文档一 §3.4）：
   * 超阈值 → 先微清理（零成本）→ 仍超 → 全量摘要压缩；连续失败熔断。
   */
  private async compactIfNeeded(abortSignal: AbortSignal): Promise<void> {
    const { emit } = this.options
    const threshold = autoCompactThreshold(this.options.model.capabilities)
    let estimate = estimateContextTokens(this.messages, this.tokenBaseline)
    if (estimate < threshold || this.compactFailures >= MAX_COMPACT_FAILURES) return

    const preTokens = estimate
    // 第一级：微清理旧工具输出（改写历史后基线失效，全量重估）
    const cleaned = microcompact(this.messages)
    if (cleaned) {
      this.messages = cleaned
      this.tokenBaseline = null
      estimate = estimateContextTokens(this.messages, null)
      if (estimate < threshold) {
        emit({ type: 'context-compacted', level: 'micro', preTokens, postTokens: estimate })
        return
      }
    }

    // 第二级：全量摘要压缩
    try {
      const result = await compactMessages(
        this.options.model.create(this.options.providerConfig),
        this.messages,
        [...this.recentReadFiles].map(([path, readAt]) => ({ path, readAt })),
        abortSignal,
      )
      this.messages = result.messages
      await this.persist((recorder) =>
        recorder.recordSnapshot('compact', this.messages, this.activeTurn?.id),
      )
      this.tokenBaseline = null
      this.compactFailures = 0
      // 消息数组已重建：旧对话回滚锚点失效（仅文件回滚仍可用），turn 起点重置
      for (const [key, rec] of this.checkpointIndex) {
        this.checkpointIndex.set(key, { ...rec, turnStartLen: -1 })
      }
      if (this.activeTurn) this.activeTurn = { ...this.activeTurn, startLen: 0 }
      const postTokens = estimateContextTokens(this.messages, null)
      emit({ type: 'context-compacted', level: 'full', preTokens, postTokens })
    } catch (error) {
      if (abortSignal.aborted) throw error
      this.compactFailures++
      // 失败不阻塞：请求可能仍能成功（估算偏保守），连续 3 次后停止尝试
    }
  }

  /** 单步：一次模型调用 + 步内工具执行；控制面工具可在成功后终止 turn。 */
  private async runOneStep(
    usage: UsageInfo,
    turnAbortSignal: AbortSignal,
  ): Promise<StepResult> {
    const { emit } = this.options
    // 步骤级中止器：turn 取消（user-cancel）与 urgent 插话（interrupt）都作用在这里
    const stepAbort = new AbortController()
    this.currentStepAbort = stepAbort
    const onTurnAbort = () => stepAbort.abort('user-cancel')
    turnAbortSignal.addEventListener('abort', onTurnAbort, { once: true })
    if (turnAbortSignal.aborted) stepAbort.abort('user-cancel')

    const stepControl = { endedByTool: false }
    try {
      const result = streamText({
        model: this.options.model.create(this.options.providerConfig),
        system: buildSystemPrompt(this.options.promptContext),
        messages: this.messages,
        tools: this.buildToolSet(stepAbort.signal, () => {
          stepControl.endedByTool = true
        }),
        stopWhen: stepCountIs(1),
        providerOptions: this.options.model.providerOptions,
        abortSignal: stepAbort.signal,
      })

      let hadToolCalls = false
      let thinkingStartedAt: number | null = null
      let stepTotalTokens = 0

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
            if (!this.protocolRound) emit({ type: 'text-delta', text: part.text })
            break
          case 'tool-call':
            hadToolCalls = true
            break
          case 'finish':
            usage.inputTokens += part.totalUsage.inputTokens ?? 0
            usage.outputTokens += part.totalUsage.outputTokens ?? 0
            usage.cachedInputTokens += part.totalUsage.inputTokenDetails.cacheReadTokens ?? 0
            // 本步的 input+output = 请求结束时完整上下文大小，作为计量基线
            stepTotalTokens =
              (part.totalUsage.inputTokens ?? 0) + (part.totalUsage.outputTokens ?? 0)
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
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, response.messages))
      if (stepTotalTokens > 0) {
        this.tokenBaseline = {
          usageTokens: stepTotalTokens,
          coveredMessageCount: this.messages.length,
        }
      }
      return { hadToolCalls, endedByTool: stepControl.endedByTool }
    } catch (error) {
      // urgent 插话打断：静默放弃本步（不入历史、不报错），交给循环注入排队消息后续跑
      if (stepAbort.signal.aborted && stepAbort.signal.reason === 'interrupt') {
        return { hadToolCalls: false, endedByTool: false }
      }
      throw error
    } finally {
      turnAbortSignal.removeEventListener('abort', onTurnAbort)
      this.currentStepAbort = null
    }
  }

  /** 包装工具集；无项目时只开放显式声明的控制面工具。 */
  private buildToolSet(
    abortSignal: AbortSignal,
    onTurnEndingTool: () => void,
  ): ToolSet | undefined {
    const projectDir = this.options.promptContext.projectDir
    const extraTools = this.options.extraTools ?? []
    const defs = projectDir
      ? [...(BUILTIN_TOOLS as ToolDefinition[]), ...extraTools]
      : extraTools.filter((tool) => tool.availableWithoutProject)
    const toolProjectDir = projectDir ?? this.options.promptContext.discussion?.scratchDir
    if (!toolProjectDir || defs.length === 0) return undefined

    const { emit, requestApproval } = this.options
    const toolSet: ToolSet = {}
    for (const def of defs) {
      toolSet[def.name] = aiTool({
        description: def.prompt,
        inputSchema: def.inputSchema,
        execute: async (input: unknown, { toolCallId }) => {
          // additionalDirs 会在审批中变化，每次调用取最新
          const toolCtx: ToolContext = {
            projectDir: toolProjectDir,
            additionalDirs: this.permissions.additionalDirs,
            abortSignal,
          }
          const parsed = def.inputSchema.safeParse(input)
          if (!parsed.success) {
            const msg = `参数校验失败：${parsed.error.message}`
            emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
            return msg
          }
          emit({ type: 'tool-start', toolUseId: toolCallId, toolName: def.name, input: parsed.data })

          // 权限判定链（文档一 §3.2）
          const decision =
            !projectDir && def.availableWithoutProject
              ? ({ behavior: 'allow' } as const)
              : checkToolPermission(def, parsed.data, this.permissions)
          if (decision.behavior === 'deny') {
            const msg = `操作被拒绝：${decision.reason}`
            emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
            return msg
          }
          if (decision.behavior === 'ask') {
            emit({ type: 'agent-status', status: 'waiting-approval' })
            const diff = await def.renderDiff?.(parsed.data, toolCtx).catch(() => undefined)
            const response = await requestApproval({
              requestId: toolCallId,
              toolName: def.name,
              input: parsed.data,
              reason: decision.reason,
              diff,
              suggestion: decision.suggestion,
            })
            emit({ type: 'agent-status', status: 'working' })
            if (!response.approved) {
              const msg = `用户拒绝了此操作（${decision.reason}）`
              emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
              return msg
            }
            if (response.remember && decision.suggestion) {
              this.applySuggestion(decision.suggestion)
            }
          }

          // 写类操作执行前拍快照（回滚语义 =「恢复到此操作前」）；讨论档只写 scratch，无需快照
          if (
            def.kind !== 'read' &&
            this.checkpoints &&
            this.activeTurn &&
            !this.permissions.discussion
          ) {
            const hash = await this.checkpoints.save()
            if (hash) {
              const { id: turnId, startLen } = this.activeTurn
              this.checkpointIndex.set(toolCallId, { hash, turnId, turnStartLen: startLen })
              if (!this.firstCheckpointOfTurn.has(turnId)) {
                this.firstCheckpointOfTurn.set(turnId, hash)
              }
              emit({ type: 'checkpoint-created', toolUseId: toolCallId, hash })
            } else if (this.checkpoints.disabled && !this.checkpointDisabledNotified) {
              this.checkpointDisabledNotified = true
              emit({ type: 'checkpoint-disabled', reason: this.checkpoints.disabled })
            }
          }

          try {
            const result = await def.execute(parsed.data, {
              ...toolCtx,
              additionalDirs: this.permissions.additionalDirs,
              onProgress: (output) =>
                emit({ type: 'tool-progress', toolUseId: toolCallId, output }),
            })
            // 记录读过的文件（压缩后重注入，防失忆）
            if (def.name === READ_FILE_TOOL_NAME && !result.isError) {
              try {
                const abs = resolveAllowed(toolCtx, (parsed.data as { path: string }).path)
                this.recentReadFiles.set(abs, Date.now())
              } catch {
                /* 越界读取已被权限层处理，这里忽略 */
              }
            }
            emit({
              type: 'tool-end',
              toolUseId: toolCallId,
              result: result.data,
              isError: result.isError,
            })
            if (def.endsTurnOnSuccess && !result.isError) onTurnEndingTool()
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

  /** 回滚到某写操作执行前（仅空闲时）；files-and-chat = 整个 turn「从没发生过」 */
  async restoreCheckpoint(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
  ): Promise<void> {
    const { emit } = this.options
    const record = this.checkpointIndex.get(toolUseId)
    if (!record || !this.checkpoints) {
      emit({ type: 'checkpoint-restored', toolUseId, turnId: '', scope, ok: false, error: '该操作没有可用快照' })
      return
    }
    if (this.running) {
      emit({ type: 'checkpoint-restored', toolUseId, turnId: record.turnId, scope, ok: false, error: 'Agent 工作中，请先停止' })
      return
    }
    // 文件+对话：文件回到该 turn 第一个快照（=turn 起点状态），与对话截断保持一致；
    // 仅文件：精确回到该操作前
    if (scope === 'files-and-chat' && record.turnStartLen < 0) {
      emit({
        type: 'checkpoint-restored',
        toolUseId,
        turnId: record.turnId,
        scope,
        ok: false,
        error: '该操作早于上下文压缩，只能回滚文件（选「仅文件」）',
      })
      return
    }
    const targetHash =
      scope === 'files-and-chat'
        ? (this.firstCheckpointOfTurn.get(record.turnId) ?? record.hash)
        : record.hash
    const result = await this.checkpoints.restoreFiles(targetHash)
    if (result.ok && scope === 'files-and-chat') {
      this.messages = this.messages.slice(0, record.turnStartLen)
      await this.persist((recorder) => recorder.recordSnapshot('rollback', this.messages))
    }
    emit({
      type: 'checkpoint-restored',
      toolUseId,
      turnId: record.turnId,
      scope,
      ok: result.ok,
      error: result.error,
    })
  }

  /** 采纳审批建议（本会话内生效，不落盘） */
  private applySuggestion(suggestion: ApprovalSuggestion): void {
    if (suggestion.kind === 'add-dir') {
      if (!this.permissions.additionalDirs.includes(suggestion.dir)) {
        this.permissions.additionalDirs.push(suggestion.dir)
      }
    } else if (!this.permissions.sessionAllowedTools.includes(suggestion.toolName)) {
      this.permissions.sessionAllowedTools.push(suggestion.toolName)
    }
  }

  /** 持久化是可靠性增强而非 Agent 可用性的单点：失败一次后明确告警并降级内存模式 */
  private async persist(action: (recorder: SessionRecorder) => Promise<void>): Promise<void> {
    const recorder = this.options.sessionRecorder
    if (!recorder || this.persistenceFailed) return
    try {
      await action(recorder)
    } catch (error) {
      this.persistenceFailed = true
      this.options.emit({
        type: 'error',
        message: `会话持久化失败，已降级为内存模式：${error instanceof Error ? error.message : String(error)}`,
        recoverable: true,
      })
    }
  }
}
