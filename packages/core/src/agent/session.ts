import { stepCountIs, streamText, tool as aiTool, type ModelMessage, type ToolSet } from 'ai'
import { isAbsolute, resolve } from 'node:path'
import type { CoreEvent, StopReason, UsageInfo, UserQuestion } from '../events.ts'
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
import {
  createTurnAbortedConsumedMessage,
  createTurnAbortedMessage,
  findPendingTurnAbortedIndex,
} from '../session/interruption.ts'
import {
  createImageUserMessage,
  messagesForModel,
} from '../attachments/messages.ts'
import type { ImageAttachment } from '../attachments/types.ts'
import { READ_FILE_TOOL_NAME } from '../tools/read-file/index.ts'
import { createAskUserQuestionTool } from '../tools/ask-user-question/index.ts'
import { resolveAllowed } from '../tools/fs-utils.ts'
import { TaskPlanController } from '../tasks/controller.ts'
import { LoopHealthMonitor } from '../tasks/loop-health.ts'
import {
  MODEL_INACTIVITY_ABORT_REASON,
  MODEL_INACTIVITY_TIMEOUT_MS,
  ModelInactivityWatchdog,
} from './model-inactivity-watchdog.ts'
import {
  createTaskPlanTools,
  type TaskPlanEngagementAction,
} from '../tasks/tools.ts'
import type { TaskPlanState } from '../tasks/types.ts'
import {
  createTaskContextMessage,
  createTaskExecutionBoundaryMessage,
  taskContextBlock,
} from '../tasks/context.ts'
import {
  createUserQuestionMarker,
  findPendingUserQuestion,
  isUserQuestionAnswer,
} from '../tasks/answer-resume.ts'
import {
  createPermissionContext,
  type ApprovalSuggestion,
  type PermissionContext,
  type PermissionMode,
} from '../permissions/types.ts'

const BOUNDED_MAX_STEPS = 40
const FINALIZATION_RESERVE_STEPS = 5
const TASK_STOP_REMINDER_LIMIT = 2
const TASK_PROGRESS_REMINDER_STEPS = 10
const MAX_COMPACT_FAILURES = 3

export interface AgentSessionOptions {
  model: ModelEntry
  providerConfig: ProviderConfig
  promptContext: PromptContext
  /** 额外注入的工具（M3：SubmitProtocolOutput 等协商工具） */
  extraTools?: ToolDefinition[]
  /** 宿主为普通 Main 注入的会话工具；讨论/协议回合物理移除（如后台命令）。 */
  mainTools?: ToolDefinition[]
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
  committed: boolean
  hadToolCalls: boolean
  toolEndReason: 'completed' | 'waiting-user' | null
  taskPlanChanged: boolean
  taskPlanEngagement: TaskPlanEngagementAction | null
  interruptionBoundaryConsumed: boolean
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
  /** 回滚是文件与会话的补偿事务；同一会话同一时刻只允许一个事务运行。 */
  private restoringCheckpointToolUseId: string | null = null
  private readonly idleWaiters = new Set<() => void>()
  /** 当前 turn ID（资源检查点归属用） */
  private activeTurn: { id: string } | null = null
  /** 当前操作（turn 或压缩）的中止器，session 自管 */
  private opAbort: AbortController | null = null
  /** 稳定 step 已结束后的持久化窗口不回滚结果，但停止请求会阻止队列自动接续。 */
  private abortRequestedDuringFinalization = false
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
  /** 仅 Main 正常执行拥有任务控制；B/C 创建时已经处于 discussion，因此不会获得。 */
  private taskPlan: TaskPlanController | null = null
  private loopHealth = new LoopHealthMonitor()
  /** 非只读工具的会话级串行尾链：审批、检查点与执行必须属于同一临界区。 */
  private serialToolTail: Promise<void> = Promise.resolve()
  /** 协商事务期间由 Orchestrator 关闭，避免协议内或执行包中途向用户提问。 */
  private userQuestionsEnabled = true
  /** 完整共识任务期间由 Coordinator 持有最终 idle，避免 Main 与任务终点之间出现假空闲。 */
  private terminalStatusManaged = false
  constructor(options: AgentSessionOptions) {
    this.options = options
    this.messages = [...(options.sessionRecorder?.initialMessages ?? [])]
    this.permissions = createPermissionContext(
      options.promptContext.projectDir,
      options.promptContext.discussion,
    )
    if (!options.promptContext.discussion) {
      this.taskPlan = new TaskPlanController(
        options.sessionRecorder?.initialTaskState,
      )
    }
    // 讨论阶段的会话不做检查点（不写项目，无需快照）
    if (
      options.promptContext.projectDir &&
      options.sessionRecorder &&
      !options.promptContext.discussion
    ) {
      this.checkpoints = new CheckpointManager({
        sessionDir: options.sessionRecorder.checkpointDirectory,
        sessionId: options.sessionRecorder.sessionId,
      })
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

  setUserQuestionsEnabled(enabled: boolean): void {
    this.userQuestionsEnabled = enabled
  }

  setTerminalStatusManaged(managed: boolean): void {
    this.terminalStatusManaged = managed
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

  get isBusy(): boolean {
    return this.running || this.compacting || this.restoringCheckpointToolUseId !== null
  }

  get checkpointRestoreToolUseId(): string | null {
    return this.restoringCheckpointToolUseId
  }

  waitUntilIdle(): Promise<void> {
    if (!this.isBusy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  /** 协商事务锚点：返回隔离副本，失败/取消时由 Orchestrator 恢复。 */
  captureMessageSnapshot(): ModelMessage[] {
    return structuredClone(this.messages)
  }

  /** 仅允许在回合结束后恢复，持久化回滚由共识任务终点统一提交。 */
  restoreMessageSnapshot(messages: ModelMessage[]): void {
    if (this.isBusy) throw new Error('Agent 工作中，不能恢复消息快照')
    this.messages = structuredClone(messages)
    this.tokenBaseline = null
  }

  captureTaskStateSnapshot(): TaskPlanState | null {
    return this.taskPlan?.stateSnapshot ?? null
  }

  restoreTaskStateSnapshot(state: TaskPlanState): void {
    if (this.isBusy) throw new Error('Agent 工作中，不能恢复任务计划')
    this.taskPlan?.restore(state)
  }

  /**
   * 用户消息统一入口：空闲时开始新 turn；运行中/压缩中则排队（steering）。
   * urgent = 打断当前步骤立即注入（Claude Code 的 now 语义），默认等当前步骤结束（next 语义）。
   */
  handleUserMessage(
    text: string,
    urgent = false,
    imageAttachments: readonly ImageAttachment[] = [],
  ): Promise<StopReason> | void {
    if (imageAttachments.length > 0) {
      if (this.isBusy) throw new Error('图片消息不能在 Agent 工作中排队或立即插话')
      if (!this.options.sessionRecorder) throw new Error('图片消息需要会话级附件存储')
      return this.startTurn([createImageUserMessage(text, imageAttachments)])
    }
    return this.handleMessage(text, urgent)
  }

  /** 协商执行包走同一模型意图路径，但不作为 urgent steering。 */
  handleExecutionMessage(text: string): Promise<StopReason> | void {
    return this.handleMessage(text, false)
  }

  private handleMessage(
    text: string,
    urgent: boolean,
  ): Promise<StopReason> | void {
    if (this.isBusy) {
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
  private startTurn(
    initialMessages: ModelMessage[],
  ): Promise<StopReason> {
    this.opAbort = new AbortController()
    return this.runLoop(initialMessages, this.opAbort.signal)
  }

  /** 用户点「停止」：中止当前 turn 或压缩 */
  abort(): void {
    if (this.opAbort) this.opAbort.abort('user-cancel')
    else if (this.running) this.abortRequestedDuringFinalization = true
  }

  private enqueueSerialTool<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serialToolTail.then(operation, operation)
    this.serialToolTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** 不能安全自动接续时，排队消息弹回输入框，不静默丢弃。 */
  private restoreQueuedInput(): void {
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

  /** 一批跨边界消息形成一个新 turn：只有第一条建立可见回滚锚点。 */
  private emitDrainedMessages(messages: QueuedMessage[]): void {
    messages.forEach((item, index) => {
      this.options.emit({
        type: 'message-injected',
        id: item.id,
        text: item.text,
        startsTurn: index === 0,
      })
    })
  }

  private resolveIdleWaiters(): void {
    if (this.isBusy) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  /** 步骤间注入真实用户消息；其语义由模型结合当前计划状态自行判断。 */
  private async injectQueuedMidTurn(): Promise<void> {
    const injected: ModelMessage[] = []
    for (const item of this.drainQueue()) {
      const message: ModelMessage = {
        role: 'user',
        content: item.text,
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
    this.abortRequestedDuringFinalization = false
    const turnId = crypto.randomUUID()
    const pendingUserQuestion = findPendingUserQuestion(this.messages)
    const answersPendingUserQuestion = pendingUserQuestion !== null
      && initialMessages.some((message) =>
        message.role === 'user'
        && isUserQuestionAnswer(pendingUserQuestion, modelMessageText(message)))
    const resumesUserQuestion = answersPendingUserQuestion
      && pendingUserQuestion.resumesTaskPlan
    let planExecutionEngaged = resumesUserQuestion
      && Boolean(this.taskPlan?.snapshot)
      && !this.taskPlan?.stateSnapshot.resumeRequired
    const initialContext = this.taskPlan?.snapshot && !planExecutionEngaged
      ? [
          createTaskExecutionBoundaryMessage(
            this.taskPlan.stateSnapshot.resumeRequired ? 'blocked' : 'dormant',
          ),
          ...initialMessages,
        ]
      : initialMessages
    // turn 起点先于 initialMessages 入栈：对话回滚锚定这里，触发指令一并移除
    this.activeTurn = { id: turnId }
    this.messages.push(...initialContext)
    await this.persist((recorder) =>
      recorder.recordTurnStart(
        turnId,
        initialContext,
        planExecutionEngaged ? this.taskPlan?.snapshot?.id : undefined,
      ),
    )

    emit({ type: 'turn-start', turnId })
    emit({ type: 'agent-status', status: 'working' })

    let stopReason: StopReason = 'completed'
    let endedByTool = false
    const maxSteps = this.options.promptContext.discussion || this.protocolRound
      ? BOUNDED_MAX_STEPS
      : null
    this.loopHealth = new LoopHealthMonitor()
    const usage: UsageInfo = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0 }
    const interruptedBoundaryPending = findPendingTurnAbortedIndex(this.messages) !== null

    try {
      let steps = 0
      let finishedNaturally = false
      let taskStopReminders = 0
      let interruptionBoundaryConsumed = false
      let steeringDecisionPending = false
      let stepsSincePlanMutation = 0
      let stepsSincePlanReminder = 0
      // 未结束计划跨 turn 保留，但执行权只属于当前 runLoop。每个新 turn 默认休眠；
      // 只有稳定提交 Create/Replace/Resume，或回答计划自身的问题卡，才启用未完成保护。
      while (maxSteps === null || steps < maxSteps) {
        if (
          planExecutionEngaged
          && this.taskPlan?.hasUnfinishedWork()
          && stepsSincePlanMutation >= TASK_PROGRESS_REMINDER_STEPS
          && stepsSincePlanReminder >= TASK_PROGRESS_REMINDER_STEPS
        ) {
          await this.injectTaskProgressReminder()
          stepsSincePlanReminder = 0
        }
        steps++
        if (maxSteps !== null && steps === maxSteps - FINALIZATION_RESERVE_STEPS) {
          await this.injectStepLimitReminder()
        }
        await this.compactIfNeeded(abortSignal, planExecutionEngaged, turnId)
        const step = await this.runOneStep(
          usage,
          abortSignal,
          planExecutionEngaged,
          interruptedBoundaryPending
            && !interruptionBoundaryConsumed
            && !this.options.promptContext.discussion
            && !this.protocolRound,
        )
        const steeringMayEndRun = steeringDecisionPending && !step.hadToolCalls
        steeringDecisionPending = false
        if (step.interruptionBoundaryConsumed) interruptionBoundaryConsumed = true
        if (step.taskPlanChanged) {
          planExecutionEngaged = Boolean(this.taskPlan?.snapshot)
          taskStopReminders = 0
          stepsSincePlanMutation = 0
          stepsSincePlanReminder = 0
        } else if (step.committed && planExecutionEngaged) {
          stepsSincePlanMutation++
          stepsSincePlanReminder++
        }
        const engagement = step.taskPlanEngagement
        if (engagement && engagement.planId === this.taskPlan?.snapshot?.id) {
          planExecutionEngaged = true
          taskStopReminders = 0
          stepsSincePlanMutation = 0
          stepsSincePlanReminder = 0
        }
        const naturalDecision = !step.hadToolCalls
          ? planExecutionEngaged && !steeringMayEndRun
            ? this.taskPlan?.naturalStopDecision() ?? { kind: 'allow' as const }
            : { kind: 'allow' as const }
          : null
        if (step.toolEndReason) {
          if (abortSignal.aborted) this.abortRequestedDuringFinalization = true
          endedByTool = true
          stopReason = step.toolEndReason
          break
        }
        // 注入点：本步工具结果已收齐、下一次模型请求前（文档一 §3.1）
        if (this.queue.length > 0) {
          if (abortSignal.aborted) {
            if (naturalDecision && naturalDecision.kind !== 'continue') {
              this.abortRequestedDuringFinalization = true
              stopReason = naturalDecision.kind === 'pause' ? 'paused' : 'completed'
              finishedNaturally = true
            } else {
              stopReason = 'aborted'
            }
            break
          }
          await this.injectQueuedMidTurn()
          steeringDecisionPending = true
          continue // 有新消息注入时，即使模型没调工具也要续一步来回应
        }
        if (abortSignal.aborted && step.hadToolCalls) {
          stopReason = 'aborted'
          break
        }
        const loopReason = this.loopHealth.consumePauseReason()
        if (loopReason) {
          if (abortSignal.aborted) this.abortRequestedDuringFinalization = true
          stopReason = 'paused'
          emit({
            type: 'error',
            message: `长任务已安全暂停：${loopReason}请检查当前计划后再继续。`,
            recoverable: true,
          })
          break
        }
        if (!step.hadToolCalls) {
          const decision = naturalDecision!
          if (decision.kind === 'continue' && abortSignal.aborted) {
            stopReason = 'aborted'
            break
          }
          if (decision.kind === 'pause') {
            if (abortSignal.aborted) this.abortRequestedDuringFinalization = true
            stopReason = 'paused'
            finishedNaturally = true
            break
          }
          if (decision.kind === 'continue' && taskStopReminders < TASK_STOP_REMINDER_LIMIT) {
            taskStopReminders++
            await this.injectTaskStopReminder(decision.reminder)
            continue
          }
          if (decision.kind === 'continue') {
            stopReason = 'paused'
            emit({
              type: 'error',
              message: `长任务仍有未完成计划，模型连续 ${TASK_STOP_REMINDER_LIMIT} 次尝试提前结束，已保留进度并安全暂停。`,
              recoverable: true,
            })
          }
          if (abortSignal.aborted) this.abortRequestedDuringFinalization = true
          finishedNaturally = true
          break
        }
      }
      if (
        stopReason === 'completed' &&
        maxSteps !== null &&
        steps >= maxSteps &&
        !endedByTool &&
        !finishedNaturally
      ) {
        stopReason = 'max-turns'
        emit({
          type: 'error',
          message: `当前协商回合已达到 ${maxSteps} 步安全上限，可能尚未完成。`,
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

    // 循环已产生稳定终态；后续短暂持久化窗口不再接受“停止”去回滚已提交 step。
    this.opAbort = null
    if (stopReason === 'aborted') {
      const interruptedState = planExecutionEngaged
        ? this.taskPlan?.interrupt('user-cancel') ?? null
        : null
      const markers: ModelMessage[] = [createTurnAbortedMessage()]
      if (interruptedState) {
        const taskContext = createTaskContextMessage(interruptedState)
        if (taskContext) markers.push(taskContext)
      }
      this.messages.push(...markers)
      await this.persist((recorder) =>
        recorder.recordStep(turnId, markers, interruptedState ?? undefined, null),
      )
    }
    await this.persist((recorder) => recorder.recordTurnEnd(turnId, stopReason))
    this.activeTurn = null
    this.opAbort = null

    emit({ type: 'turn-end', turnId, usage, stopReason })

    // 收尾持久化窗口进入的消息也必须有确定归宿；普通 Main 作为新 turn 接续。
    if (
      this.queue.length > 0
      && stopReason !== 'aborted'
      && !this.protocolRound
      && !this.abortRequestedDuringFinalization
    ) {
      const drained = this.drainQueue()
      this.emitDrainedMessages(drained)
      return this.startTurn(
        drained.map((q) => ({ role: 'user' as const, content: q.text })),
      )
    }

    this.running = false
    this.abortRequestedDuringFinalization = false
    if (this.queue.length > 0) this.restoreQueuedInput()
    if (!this.terminalStatusManaged) {
      emit({ type: 'agent-status', status: stopReason === 'error' ? 'error' : 'idle' })
    }
    this.resolveIdleWaiters()
    return stopReason
  }

  /** 给模型预留收尾窗口，避免一直扩展探索直到安全上限才突然停止。 */
  private async injectStepLimitReminder(): Promise<void> {
    const reminder: ModelMessage = {
      role: 'user',
      content: [
        '<system-reminder>',
        `当前协商回合还剩 ${FINALIZATION_RESERVE_STEPS + 1} 次模型请求即达到安全上限。`,
        '请停止扩展性探索，只做必要收尾；能完成时立即给出完整结论，协议阶段则立即提交正式协议输出。',
        '</system-reminder>',
      ].join('\n'),
    }
    this.messages.push(reminder)
    if (this.activeTurn) {
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, [reminder]))
    }
  }

  private async injectTaskStopReminder(text: string): Promise<void> {
    const reminder: ModelMessage = {
      role: 'user',
      content: ['<system-reminder>', text, '</system-reminder>'].join('\n'),
    }
    this.messages.push(reminder)
    if (this.activeTurn) {
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, [reminder]))
    }
  }

  private async injectTaskProgressReminder(): Promise<void> {
    const plan = this.taskPlan?.snapshot
    if (!plan) return
    const current = plan.items.find((item) => item.status === 'in_progress')
    const reminder: ModelMessage = {
      role: 'user',
      content: [
        '<system-reminder>',
        `计划 ${plan.id} 已有 ${TASK_PROGRESS_REMINDER_STEPS} 个模型步骤没有更新。`,
        current ? `当前任务项：${current.id} ${current.title}。` : '',
        '若进度、阻塞或任务项已实质变化，请更新计划；若复杂测试或排查尚无结论，继续工作即可，不要制造进度。',
        '不要向用户提及本提醒。',
        '</system-reminder>',
      ].filter(Boolean).join('\n'),
    }
    this.messages.push(reminder)
    if (this.activeTurn) {
      await this.persist((recorder) => recorder.recordStep(this.activeTurn!.id, [reminder]))
    }
  }

  /** 手动压缩（用户主动触发，不看阈值）：直接走全量摘要；期间用户消息排队，完成后接续 */
  async compactNow(): Promise<void> {
    const { emit } = this.options
    if (this.isBusy) {
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
        this.compactTaskContext(),
        (messages) => this.messagesForCurrentModel(messages),
      )
      this.messages = result.messages
      await this.persist((recorder) =>
        recorder.recordSnapshot('compact', this.messages, undefined, this.taskPlan?.stateSnapshot),
      )
      this.tokenBaseline = null
      this.compactFailures = 0
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
    this.opAbort = null

    // 压缩期间排队的消息：取消则弹回输入框；正常结束则在新上下文上接续为新 turn
    if (signal.aborted) {
      this.restoreQueuedInput()
    } else if (this.queue.length > 0) {
      const drained = this.drainQueue()
      this.emitDrainedMessages(drained)
      await this.startTurn(
        drained.map((q) => ({ role: 'user' as const, content: q.text })),
      )
      return
    }
    emit({ type: 'agent-status', status: 'idle' })
    this.resolveIdleWaiters()
  }

  /**
   * 上下文压缩检查（每次模型请求前，文档一 §3.4）：
   * 超阈值 → 先微清理（零成本）→ 仍超 → 全量摘要压缩；连续失败熔断。
   */
  private async compactIfNeeded(
    abortSignal: AbortSignal,
    planExecutionEngaged: boolean,
    turnId: string,
  ): Promise<void> {
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
        this.compactTaskContext(planExecutionEngaged, turnId),
        (messages) => this.messagesForCurrentModel(messages),
      )
      this.messages = result.messages
      await this.persist((recorder) =>
        recorder.recordSnapshot(
          'compact',
          this.messages,
          this.activeTurn?.id,
          this.taskPlan?.stateSnapshot,
        ),
      )
      this.tokenBaseline = null
      this.compactFailures = 0
      // 消息数组已重建：旧对话回滚锚点失效（仅文件回滚仍可用）
      const postTokens = estimateContextTokens(this.messages, null)
      emit({ type: 'context-compacted', level: 'full', preTokens, postTokens })
    } catch (error) {
      if (abortSignal.aborted) throw error
      this.compactFailures++
      // 失败不阻塞：请求可能仍能成功（估算偏保守），连续 3 次后停止尝试
    }
  }

  private compactTaskContext(planExecutionEngaged = false, turnId?: string): string | undefined {
    const state = this.taskPlan?.stateSnapshot
    if (!state || (!state.activePlan && state.historicalPlans.length === 0)) return undefined
    const continuation = planExecutionEngaged && turnId && state.activePlan
      ? { turnId, engagedPlanId: state.activePlan.id }
      : undefined
    return taskContextBlock(state, continuation)
  }

  private messagesForCurrentModel(messages: ModelMessage[]): Promise<ModelMessage[]> {
    return messagesForModel(
      messages,
      this.options.model.capabilities.supportsImageInput,
      this.options.sessionRecorder?.attachmentDirectory,
      this.sessionImageAttachments(),
    )
  }

  private sessionImageAttachments(): ImageAttachment[] {
    return (this.options.sessionRecorder?.initialViewEvents ?? []).flatMap((event) =>
      event.type === 'user-message' ? event.attachments ?? [] : [])
  }

  /** 单步：一次模型调用 + 步内工具执行；控制面工具可在成功后终止 turn。 */
  private async runOneStep(
    usage: UsageInfo,
    turnAbortSignal: AbortSignal,
    planExecutionEngaged: boolean,
    consumeInterruptionBoundary: boolean,
  ): Promise<StepResult> {
    const { emit } = this.options
    // 步骤级中止器：turn 取消（user-cancel）与 urgent 插话（interrupt）都作用在这里
    const stepAbort = new AbortController()
    const inactivityWatchdog = new ModelInactivityWatchdog(stepAbort)
    this.currentStepAbort = stepAbort
    const onTurnAbort = () => stepAbort.abort('user-cancel')
    turnAbortSignal.addEventListener('abort', onTurnAbort, { once: true })
    if (turnAbortSignal.aborted) stepAbort.abort('user-cancel')
    inactivityWatchdog.start()

    const stepControl: {
      toolEndReason: StepResult['toolEndReason']
      taskPlanEngagement: TaskPlanEngagementAction | null
    } = {
      toolEndReason: null,
      taskPlanEngagement: null,
    }
    let userQuestion: UserQuestion | null = null
    this.taskPlan?.beginStep()
    try {
      const result = streamText({
        model: this.options.model.create(this.options.providerConfig),
        system: buildSystemPrompt(this.options.promptContext),
        messages: await this.messagesForCurrentModel(this.messages),
        tools: this.buildToolSet(
          stepAbort.signal,
          planExecutionEngaged,
          (action) => { stepControl.taskPlanEngagement = action },
          (question) => { userQuestion = question },
          (reason) => { stepControl.toolEndReason = reason },
        ),
        stopWhen: stepCountIs(1),
        providerOptions: this.options.model.providerOptions,
        abortSignal: stepAbort.signal,
        onToolExecutionStart: () => { inactivityWatchdog.toolStarted() },
        onToolExecutionEnd: () => { inactivityWatchdog.toolEnded() },
      })

      let hadToolCalls = false
      let thinkingStartedAt: number | null = null
      let stepTotalTokens = 0

      for await (const part of result.fullStream) {
        inactivityWatchdog.noteStreamActivity()
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

      // 流和工具尚未完整结束前的停止必须丢弃本步；从这里开始进入稳定提交窗口。
      if (stepAbort.signal.aborted) throw new Error('step aborted before commit')
      const response = await result.response
      if (stepAbort.signal.aborted) throw new Error('step aborted before commit')
      const taskPlanCommit = this.taskPlan?.commitStep()
      const planRemainsActive = Boolean(
        taskPlanCommit ? taskPlanCommit.state.activePlan : this.taskPlan?.snapshot,
      )
      const questionResumesTaskPlan = userQuestion !== null
        && stepControl.toolEndReason === 'waiting-user'
        && planRemainsActive
        && (
          planExecutionEngaged
          || stepControl.taskPlanEngagement?.type === 'resume'
          || taskPlanCommit !== undefined
        )
      const internalMarkers: ModelMessage[] = []
      if (consumeInterruptionBoundary) {
        internalMarkers.push(createTurnAbortedConsumedMessage())
      }
      if (userQuestion && stepControl.toolEndReason === 'waiting-user') {
        internalMarkers.push(createUserQuestionMarker(
          userQuestion,
          questionResumesTaskPlan,
        ))
      }
      const committedMessages = [...response.messages, ...internalMarkers]
      const engagementUpdate = taskPlanCommit
        ? taskPlanCommit.state.activePlan?.id ?? null
        : stepControl.taskPlanEngagement?.planId
      this.messages.push(...committedMessages)
      await this.persist((recorder) =>
        recorder.recordStep(
          this.activeTurn!.id,
          committedMessages,
          taskPlanCommit?.state,
          engagementUpdate,
        ),
      )
      if (userQuestion && stepControl.toolEndReason === 'waiting-user') {
        emit({ type: 'user-question', question: userQuestion })
      }
      if (taskPlanCommit) {
        const update = taskPlanCommit.displayUpdate
        emit(update.kind === 'replaced'
          ? { type: 'task-plan-replaced', previous: update.previous, plan: update.plan }
          : { type: 'task-plan-updated', plan: update.plan })
      }
      emit({ type: 'step-committed' })
      if (stepTotalTokens > 0) {
        this.tokenBaseline = {
          usageTokens: stepTotalTokens,
          coveredMessageCount: this.messages.length,
        }
      }
      return {
        committed: true,
        hadToolCalls,
        toolEndReason: stepControl.toolEndReason,
        taskPlanChanged: taskPlanCommit !== undefined,
        taskPlanEngagement: stepControl.taskPlanEngagement,
        interruptionBoundaryConsumed: consumeInterruptionBoundary,
      }
    } catch (error) {
      this.taskPlan?.discardStep()
      emit({ type: 'step-discarded' })
      if (
        stepAbort.signal.aborted
        && stepAbort.signal.reason === MODEL_INACTIVITY_ABORT_REASON
      ) {
        throw new Error(
          `模型连续 ${Math.round(MODEL_INACTIVITY_TIMEOUT_MS / 1000)} 秒没有返回数据，当前未提交步骤已安全丢弃；请重试或切换模型。`,
        )
      }
      // urgent 插话打断：静默放弃本步（不入历史、不报错），交给循环注入排队消息后续跑
      if (stepAbort.signal.aborted && stepAbort.signal.reason === 'interrupt') {
        return {
          committed: false,
          hadToolCalls: false,
          toolEndReason: null,
          taskPlanChanged: false,
          taskPlanEngagement: null,
          interruptionBoundaryConsumed: false,
        }
      }
      throw error
    } finally {
      inactivityWatchdog.stop()
      turnAbortSignal.removeEventListener('abort', onTurnAbort)
      this.currentStepAbort = null
    }
  }

  /** 包装工具集；无项目时只开放显式声明的控制面工具。 */
  private buildToolSet(
    abortSignal: AbortSignal,
    planExecutionEngaged: boolean,
    onTaskPlanEngagement: (action: TaskPlanEngagementAction) => void,
    onUserQuestion: (question: UserQuestion) => void,
    onTurnEndingTool: (reason: 'completed' | 'waiting-user') => void,
  ): ToolSet | undefined {
    const projectDir = this.options.promptContext.projectDir
    const extraTools = this.options.extraTools ?? []
    const taskTools = this.taskPlan
      && !this.options.promptContext.discussion
      && !this.protocolRound
      ? createTaskPlanTools(this.taskPlan, {
          onEngagementAction: onTaskPlanEngagement,
          isEngaged: () => planExecutionEngaged,
        })
      : []
    const questionTools: ToolDefinition[] =
      this.userQuestionsEnabled
      && !this.options.promptContext.discussion
      && !this.protocolRound
        ? [
            createAskUserQuestionTool((question) => {
              onUserQuestion(question)
            }),
          ]
        : []
    const mainTools = !this.options.promptContext.discussion
      && !this.protocolRound
      ? (this.options.mainTools ?? [])
      : []
    const controlTools: ToolDefinition[] = [
      ...extraTools,
      ...taskTools,
      ...questionTools,
      ...mainTools,
    ]
    const availableDefs: ToolDefinition[] = projectDir
      ? [...(BUILTIN_TOOLS as ToolDefinition[]), ...controlTools]
      : controlTools.filter((tool) => tool.availableWithoutProject)
    const defs = availableDefs
    const toolProjectDir =
      projectDir ?? this.options.promptContext.discussion?.scratchDir ?? process.cwd()
    if (defs.length === 0) return undefined

    const { emit, requestApproval } = this.options
    const toolSet: ToolSet = {}
    let firstStepToolName: string | null = null
    let standaloneStepToolName: string | null = null
    const claimStepTool = (def: ToolDefinition): string | null => {
      if (standaloneStepToolName) {
        return `${standaloneStepToolName} 必须独占一个模型步骤；请在下一模型步骤再调用 ${def.name}。`
      }
      if (def.requiresStandaloneStep && firstStepToolName) {
        return `${def.name} 必须独占一个模型步骤，但本步骤已经调用 ${firstStepToolName}；请在下一模型步骤单独调用 ${def.name}。`
      }
      firstStepToolName ??= def.name
      if (def.requiresStandaloneStep) standaloneStepToolName = def.name
      return null
    }
    for (const def of defs) {
      const executeTool = async (
        input: unknown,
        { toolCallId }: { toolCallId: string },
      ): Promise<string> => {
        if (abortSignal.aborted) return '操作已取消'
        // additionalDirs 会在审批中变化，每次调用取最新
        let toolCtx: ToolContext = {
          projectDir: toolProjectDir,
          additionalDirs: this.permissions.additionalDirs,
          abortSignal,
        }
        const parsed = def.inputSchema.safeParse(input)
        if (!parsed.success) {
          const msg = `参数校验失败：${parsed.error.message}`
          emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
          this.loopHealth.record(def.name, input, msg, true)
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
          this.loopHealth.record(def.name, parsed.data, msg, true)
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
            this.loopHealth.record(def.name, parsed.data, msg, true)
            return msg
          }
          const approvedPaths = def.extractPaths?.(parsed.data) ?? []
          if (approvedPaths.length > 0) {
            // 用户批准的是这组完整输入：路径只扩展当前调用，是否持久化仍由 remember 决定。
            toolCtx = {
              ...toolCtx,
              additionalDirs: [
                ...toolCtx.additionalDirs,
                ...approvedPaths.map((path) =>
                  isAbsolute(path) ? resolve(path) : resolve(toolProjectDir, path),
                ),
              ],
            }
          }
          if (response.remember && decision.suggestion) {
            this.applySuggestion(decision.suggestion)
          }
        }

        // 只有工具显式声明资源边界才建立检查点；权限路径不能替代回滚覆盖契约。
        let preparedCheckpoint: Awaited<ReturnType<CheckpointManager['prepare']>> = null
        if (
          (def.kind === 'edit' || def.kind === 'execute') &&
          this.checkpoints &&
          this.activeTurn &&
          !this.permissions.discussion
        ) {
          const turnId = this.activeTurn.id
          if (!def.checkpointScope) {
            await this.checkpoints
              .recordBarrier(toolCallId, turnId, `${def.name} 未声明可回滚资源范围`)
              .catch(() => {})
          } else {
            try {
              const checkpointScope = await def.checkpointScope(parsed.data, toolCtx)
              preparedCheckpoint = await this.checkpoints.prepare(
                toolCallId,
                turnId,
                checkpointScope,
              )
              if (!preparedCheckpoint) {
                const reason = this.checkpoints.disabled ?? `${def.name} 未建立检查点`
                await this.checkpoints.recordBarrier(
                  toolCallId,
                  turnId,
                  reason,
                )
                if (!this.checkpointDisabledNotified) {
                  this.checkpointDisabledNotified = true
                  emit({ type: 'checkpoint-disabled', reason })
                }
              }
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error)
              await this.checkpoints.recordBarrier(toolCallId, turnId, reason).catch(() => {})
              if (!this.checkpointDisabledNotified) {
                this.checkpointDisabledNotified = true
                emit({ type: 'checkpoint-disabled', reason })
              }
            }
          }
        }

        const finalizeCheckpoint = async (): Promise<void> => {
          if (!preparedCheckpoint || !this.checkpoints) return
          const ready = await this.checkpoints.finalize(preparedCheckpoint)
          if (ready) {
            emit({
              type: 'checkpoint-created',
              toolUseId: toolCallId,
              hash: ready.id,
              coverage: 'complete',
            })
          } else if (this.checkpoints.disabled && !this.checkpointDisabledNotified) {
            this.checkpointDisabledNotified = true
            emit({ type: 'checkpoint-disabled', reason: this.checkpoints.disabled })
          }
        }

        try {
          const result = await def.execute(parsed.data, {
            ...toolCtx,
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
          await finalizeCheckpoint()
          emit({
            type: 'tool-end',
            toolUseId: toolCallId,
            result: result.data,
            isError: result.isError,
          })
          if (def.endsTurnOnSuccess && !result.isError) {
            onTurnEndingTool(def.turnEndReasonOnSuccess)
          }
          this.loopHealth.record(def.name, parsed.data, result.data, result.isError)
          return result.data
        } catch (error) {
          await finalizeCheckpoint()
          const msg = `工具执行出错：${error instanceof Error ? error.message : String(error)}`
          emit({ type: 'tool-end', toolUseId: toolCallId, result: msg, isError: true })
          this.loopHealth.record(def.name, parsed.data, msg, true)
          return msg
        }
      }
      const executeWithStepGate = (
        input: unknown,
        context: { toolCallId: string },
      ): Promise<string> => {
        const conflict = claimStepTool(def)
        if (conflict) {
          emit({
            type: 'tool-end',
            toolUseId: context.toolCallId,
            result: conflict,
            isError: true,
          })
          this.loopHealth.record(def.name, input, conflict, true)
          return Promise.resolve(conflict)
        }
        return def.isReadOnly
          ? executeTool(input, context)
          : this.enqueueSerialTool(() => executeTool(input, context))
      }
      toolSet[def.name] = aiTool({
        description: def.prompt,
        inputSchema: def.inputSchema,
        execute: executeWithStepGate,
      })
    }
    return toolSet
  }

  /** 回滚到某写操作执行前（仅空闲时）；files-and-chat = 整个 turn「从没发生过」 */
  async restoreCheckpoint(
    toolUseId: string,
    scope: 'files' | 'files-and-chat',
  ): Promise<void> {
    if (!this.checkpoints) {
      this.emitCheckpointRestored({
        type: 'checkpoint-restored', toolUseId, turnId: '', scope, ok: false,
        error: '该操作没有可用快照',
      })
      return
    }
    if (this.running || this.compacting) {
      this.emitCheckpointRestored({
        type: 'checkpoint-restored', toolUseId, turnId: '', scope, ok: false,
        error: 'Agent 工作中，请先停止',
      })
      return
    }
    // Renderer 会立即禁用按钮；这里仍做核心层单飞，防 IPC 重复提交或其它宿主并发调用。
    if (this.restoringCheckpointToolUseId) return
    this.restoringCheckpointToolUseId = toolUseId
    try {
      const record = await this.checkpoints.getReady(toolUseId)
      if (!record) {
        this.emitCheckpointRestored({
          type: 'checkpoint-restored', toolUseId, turnId: '', scope, ok: false,
          error: '该操作没有可用快照',
        })
        return
      }
      const recorder = this.options.sessionRecorder
      const rollbackMessages = scope === 'files-and-chat'
        ? recorder?.messagesBeforeTurn(record.turnId) ?? null
        : null
      const rollbackTaskState = scope === 'files-and-chat'
        ? recorder?.taskStateBeforeTurn(record.turnId)
        : undefined
      if (
        scope === 'files-and-chat' &&
        (rollbackMessages === null || rollbackTaskState === undefined)
      ) {
        this.emitCheckpointRestored({
          type: 'checkpoint-restored',
          toolUseId,
          turnId: record.turnId,
          scope,
          ok: false,
          error: '该轮早于上下文压缩或当前活动历史，只能回滚文件（选「仅文件」）',
        })
        return
      }
      const originalMessages = structuredClone(this.messages)
      const originalTaskState = this.taskPlan?.stateSnapshot
      const rollbackQuestion = rollbackMessages === null
        ? undefined
        : findPendingUserQuestion(rollbackMessages)?.question ?? null
      const result = await this.checkpoints.restore(
        toolUseId,
        scope,
        rollbackMessages !== null && recorder ? {
          commit: async () => {
            await recorder.recordSnapshot('rollback', rollbackMessages, undefined, rollbackTaskState)
            this.messages = structuredClone(rollbackMessages)
            this.taskPlan?.restore(rollbackTaskState!)
            this.tokenBaseline = null
          },
          compensate: async () => {
            await recorder.recordSnapshot('rollback', originalMessages, undefined, originalTaskState)
            this.messages = structuredClone(originalMessages)
            if (originalTaskState) this.taskPlan?.restore(originalTaskState)
            this.tokenBaseline = null
          },
        } : undefined,
      )
      this.emitCheckpointRestored({
        type: 'checkpoint-restored',
        toolUseId,
        turnId: result.turnId ?? record.turnId,
        scope,
        ok: result.ok,
        error: result.error,
        invalidatedToolUseIds: result.invalidatedToolUseIds,
        ...(result.ok && scope === 'files-and-chat'
          ? { taskPlan: rollbackTaskState?.activePlan ?? null, question: rollbackQuestion ?? null }
          : {}),
      })
    } finally {
      this.restoringCheckpointToolUseId = null
      if (this.queue.length > 0) {
        const drained = this.drainQueue()
        this.emitDrainedMessages(drained)
        await this.startTurn(
          drained.map((item) => ({ role: 'user' as const, content: item.text })),
        )
      }
      this.resolveIdleWaiters()
    }
  }

  private emitCheckpointRestored(
    event: Extract<CoreEvent, { type: 'checkpoint-restored' }>,
  ): void {
    this.restoringCheckpointToolUseId = null
    this.options.emit(event)
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

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}
