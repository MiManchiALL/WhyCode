import { randomUUID } from 'node:crypto'
import {
  isStepScopedCoreEvent,
  type AgentSession,
  type AgentStatus,
  type ApprovalRequest,
  type ApprovalResponse,
  type ConsensusCoordinator,
  type CoreEvent,
  type ContextUsageInfo,
  type ReasoningEffortSelection,
  type SessionJournal,
  type TurnInterruptionContext,
  type ManagedWorkspaceBinding,
  type WorkspaceBinding,
  type WorktreeWorkspaceBinding,
  workspaceWorkingDirectory,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'
import type {
  PendingManagedWorkspace,
  PendingWorktreeWorkspace,
  RuntimeWorkspace,
} from '../shared/workspace.ts'
import { UserMessageRoutingGate } from './user-message-routing.ts'
import { ViewTimeline } from './view-timeline.ts'

export interface DesktopSessionRuntimeOptions {
  runtimeId?: string
  workspace: RuntimeWorkspace
  modelId: string | null
  reasoningEffort?: ReasoningEffortSelection
  permissionMode?: PermissionMode
  emit: (runtime: DesktopSessionRuntime, event: CoreEvent, occurredAt: string) => void
}

interface PendingApproval {
  request: ApprovalRequest
  resolve: (response: ApprovalResponse) => void
}

/**
 * 一个对话的全部易变运行状态。磁盘事实由 SessionJournal 持有，宿主级设置与
 * 共享资源由 Registry/调度器持有；二者不再借用“当前对话”全局变量互相寻址。
 */
export class DesktopSessionRuntime {
  readonly runtimeId: string
  readonly routingGate = new UserMessageRoutingGate()
  readonly timeline: ViewTimeline
  private currentWorkspace: RuntimeWorkspace
  journal: SessionJournal | null = null
  session: AgentSession | null = null
  sessionInitialization: Promise<string | null> | null = null
  coordinator: ConsensusCoordinator | null = null
  consensusEnabled = false
  status: AgentStatus = 'idle'
  modelId: string | null
  reasoningEffort: ReasoningEffortSelection
  permissionMode: PermissionMode
  contextUsage: ContextUsageInfo | null = null
  workStartedAt: number | null = null
  private workOutcome: 'completed' | 'stopped' = 'completed'
  private forkTurnId: string | null = null
  private btwWorkActive = false
  attachmentPreparationInProgress = false
  lastSelectedAt = Date.now()
  private readonly emitToHost: DesktopSessionRuntimeOptions['emit']
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  private readonly idleWaiters = new Set<() => void>()
  private attachmentAbort: AbortController | null = null
  /** 子代理等宿主拥有的异步工作；阻止卸载/删除，但不占用户会话并发名额。 */
  private externalWorkCount = 0
  private disposed = false

  constructor(options: DesktopSessionRuntimeOptions) {
    this.runtimeId = options.runtimeId ?? randomUUID()
    this.currentWorkspace = options.workspace
    this.modelId = options.modelId
    this.reasoningEffort = options.reasoningEffort ?? 'default'
    this.permissionMode = options.permissionMode ?? 'default'
    this.emitToHost = options.emit
    this.timeline = new ViewTimeline((error) => {
      this.emit({
        type: 'error',
        message: `界面历史未能写入会话记录：${
          error instanceof Error ? error.message : String(error)
        }`,
        recoverable: true,
      }, false)
    })
  }

  get sessionId(): string | null {
    return this.journal?.sessionId ?? null
  }

  get workspace(): RuntimeWorkspace {
    return this.currentWorkspace
  }

  get workspaceBinding(): WorkspaceBinding | null {
    return this.currentWorkspace.mode === 'pending-worktree'
      || this.currentWorkspace.mode === 'pending-managed'
      ? null
      : this.currentWorkspace
  }

  get pendingManaged(): PendingManagedWorkspace | null {
    return this.currentWorkspace.mode === 'pending-managed'
      ? this.currentWorkspace
      : null
  }

  get pendingWorktree(): PendingWorktreeWorkspace | null {
    return this.currentWorkspace.mode === 'pending-worktree'
      ? this.currentWorkspace
      : null
  }

  get projectDir(): string | null {
    const binding = this.workspaceBinding
    return binding ? workspaceWorkingDirectory(binding) : null
  }

  bindPendingWorktree(binding: WorktreeWorkspaceBinding): void {
    const pending = this.pendingWorktree
    if (!pending) throw new Error('当前运行时没有待创建的 Worktree')
    if (
      binding.id !== this.runtimeId
      || binding.baseRef !== pending.baseRef
      || binding.baseCommit !== pending.expectedBaseCommit
    ) {
      throw new Error('创建结果与待创建 Worktree 选择不一致')
    }
    this.currentWorkspace = binding
  }

  bindPendingManaged(binding: ManagedWorkspaceBinding): void {
    const pending = this.pendingManaged
    if (!pending) throw new Error('当前运行时没有待创建的默认工作区')
    if (
      binding.id !== this.runtimeId
      || binding.id !== pending.id
      || binding.workingDirectory !== pending.workingDirectory
    ) {
      throw new Error('创建结果与待创建默认工作区不一致')
    }
    this.currentWorkspace = binding
  }

  get checkpointRestoreToolUseId(): string | null {
    return this.session?.checkpointRestoreToolUseId ?? null
  }

  get approval(): ApprovalRequest | null {
    return [...this.pendingApprovals.values()].at(-1)?.request ?? null
  }

  get busy(): boolean {
    return this.userRunBusy || this.externalWorkCount > 0
  }

  get userRunBusy(): boolean {
    return this.executionBusy || this.routingGate.busy
  }

  /**
   * 已进入会话执行生命周期的工作；特意不含输入路由闸门。调用方持有自己的
   * FIFO reservation 时，用它判断这条消息是否真正开启新 turn。
   */
  get executionBusy(): boolean {
    return Boolean(
      this.attachmentPreparationInProgress
      || this.sessionInitialization
      || this.session?.isBusy
      || this.coordinator?.busy,
    )
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  emit(event: CoreEvent, persistView = true): void {
    if (this.disposed) return
    if (event.type === 'context-usage') {
      this.contextUsage = event.usage ? structuredClone(event.usage) : null
    }
    if (event.type === 'turn-end') {
      this.forkTurnId = event.stopReason === 'completed' ? event.turnId : null
    }
    if (event.type === 'error') this.forkTurnId = null
    if (event.type === 'agent-status') {
      this.status = event.status
      if (event.status === 'error') this.forkTurnId = null
    }
    if (
      event.type === 'agent-status'
      && (event.status === 'idle' || event.status === 'error')
      && !this.btwWorkActive
    ) {
      this.finishWork()
    }
    this.publish(event, persistView)
    this.notifyStateChanged()
  }

  /** 运行中的 BTW step 只借用时间线缓冲供切换会话快照使用，不提交为 Main 历史。 */
  emitBtw(event: CoreEvent): void {
    const bufferForSnapshot = isStepScopedCoreEvent(event) || event.type === 'step-discarded'
    this.emit(event, bufferForSnapshot)
  }

  beginWork(): void {
    if (this.disposed || this.workStartedAt !== null) return
    this.workOutcome = 'completed'
    this.forkTurnId = null
    this.workStartedAt = Date.now()
    this.publish({ type: 'work-started', startedAt: this.workStartedAt }, false)
  }

  beginBtwWork(): void {
    if (this.btwWorkActive) throw new Error('BTW 工作边界重复启动')
    this.btwWorkActive = true
    this.beginWork()
  }

  finishWork(): void {
    if (this.disposed || this.workStartedAt === null) return
    const durationMs = Math.max(0, Date.now() - this.workStartedAt)
    this.workStartedAt = null
    const outcome = this.workOutcome
    const forkTurnId = outcome === 'completed' ? this.forkTurnId : null
    this.workOutcome = 'completed'
    this.forkTurnId = null
    this.publish({ type: 'work-finished', durationMs, outcome, forkTurnId }, true)
  }

  /** BTW 的可见终点由独立 JSONL 事实恢复，不能再写一份 ViewTimeline 副本。 */
  finishBtwWork(
    durationMs: number,
    outcome: 'completed' | 'stopped' | 'error',
    continuesWithMainWork: boolean,
    btw: {
      conversationId: string
      turnIndex: number
      continuationAvailable: boolean
    },
  ): void {
    if (this.disposed || !this.btwWorkActive || this.workStartedAt === null) return
    this.btwWorkActive = false
    this.workStartedAt = null
    this.workOutcome = 'completed'
    this.forkTurnId = null
    this.publish({
      type: 'work-finished',
      durationMs: Math.max(0, durationMs),
      outcome: outcome === 'completed' ? 'completed' : 'stopped',
      forkTurnId: null,
      btw,
    }, false)
    if (continuesWithMainWork) this.beginWork()
  }

  private publish(event: CoreEvent, persistView: boolean): void {
    const occurredAt = new Date().toISOString()
    if (persistView) this.timeline.capture(this.journal, event, occurredAt)
    this.emitToHost(this, event, occurredAt)
  }

  beginAttachmentPreparation(): AbortSignal {
    if (this.attachmentPreparationInProgress) {
      throw new Error('上一条附件消息仍在准备')
    }
    this.attachmentAbort = new AbortController()
    this.attachmentPreparationInProgress = true
    return this.attachmentAbort.signal
  }

  endAttachmentPreparation(): void {
    this.attachmentAbort = null
    this.attachmentPreparationInProgress = false
    this.notifyStateChanged()
  }

  waitUntilIdle(): Promise<void> {
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  notifyStateChanged(): void {
    if (this.busy) return
    for (const resolve of this.idleWaiters) resolve()
    this.idleWaiters.clear()
  }

  beginExternalWork(): void {
    if (this.disposed) throw new Error('已释放的会话不能启动子代理工作')
    this.externalWorkCount++
    this.notifyStateChanged()
  }

  endExternalWork(): void {
    if (this.externalWorkCount <= 0) throw new Error('会话异步工作计数不平衡')
    this.externalWorkCount--
    this.notifyStateChanged()
  }

  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    if (this.disposed) return Promise.resolve({ approved: false })
    if (this.permissionMode === 'auto') return Promise.resolve({ approved: true })
    return new Promise((resolve) => {
      this.pendingApprovals.set(request.requestId, {
        request: structuredClone(request),
        resolve,
      })
      this.emit({ type: 'approval-request', ...request })
    })
  }

  respondApproval(
    requestId: string,
    response: ApprovalResponse,
  ): boolean {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return false
    this.pendingApprovals.delete(requestId)
    pending.resolve(response)
    return true
  }

  rejectApprovals(): void {
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve({ approved: false })
    }
    this.pendingApprovals.clear()
  }

  setPermissionMode(mode: PermissionMode): void {
    this.session?.setPermissionMode(mode)
    this.permissionMode = mode
    if (mode === 'readonly') {
      this.rejectApprovals()
      return
    }
    if (mode === 'auto') {
      for (const pending of this.pendingApprovals.values()) {
        pending.resolve({ approved: true })
      }
      this.pendingApprovals.clear()
    }
  }

  async abort(
    source: 'user' | 'shutdown' = 'user',
    interruption?: TurnInterruptionContext,
  ): Promise<void> {
    if (source === 'user' && this.workStartedAt !== null) this.workOutcome = 'stopped'
    this.attachmentAbort?.abort('user-cancel')
    this.rejectApprovals()
    if (this.coordinator) await this.coordinator.abort(interruption)
    else this.session?.abort(interruption)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    if (this.busy) throw new Error('运行中的会话不能直接释放')
    this.disposed = true
    this.rejectApprovals()
    this.idleWaiters.clear()
    this.timeline.discardAll()
    await this.timeline.flush()
    await this.journal?.sealMetadataCache()
    const target = this.session
    this.session = null
    this.coordinator = null
    await target?.dispose()
  }
}
