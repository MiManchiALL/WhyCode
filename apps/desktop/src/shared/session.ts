import type {
  AgentStatus,
  ApprovalRequest,
  BackgroundTaskState,
  CheckpointFileCurrentMatchResult,
  CheckpointFilePreviewResult,
  CurrentFilePreviewResult,
  CoreCommand,
  CoreEvent,
  ContextUsageInfo,
  QueuedUserMessage,
  SessionForkOrigin,
  SessionSummary,
  SubagentState,
  ReasoningEffortSelection,
} from '@whycode/core'
import type { ConversationHistoryWindow } from './conversation-history.ts'
import type { SkillSummary } from '@whycode/core/skills'
import type { ToolFileChange } from '@whycode/core/events'
import type { PermissionMode } from '@whycode/core/permissions'
import type {
  RuntimeWorkspace,
  StartWorkspaceRequest,
} from './workspace.ts'

export type SessionListItem = SessionSummary & {
  isCurrent: boolean
  running: boolean
  pinned: boolean
  /** 非当前对话已结束一段工作，且用户尚未重新打开它。 */
  hasUnreadCompletion: boolean
}

export interface SetSessionPinnedRequest {
  sessionId: string
  pinned: boolean
}

export type SetSessionPinnedResult =
  | { ok: true }
  | { ok: false; error: string }

/** Renderer 可随时丢失；主进程用该快照恢复稳定界面和仍在运行的控制状态。 */
export interface RuntimeSnapshot {
  /** 对话运行时的稳定路由 ID；草稿尚未建立 JSONL 时也存在。 */
  runtimeId: string
  workspace: RuntimeWorkspace
  modelId: string | null
  reasoningEffort: ReasoningEffortSelection
  permissionMode: PermissionMode
  /** Core 在当前模型请求边界给出的统一上下文估算。 */
  contextUsage: ContextUsageInfo | null
  /** 当前连续工作的权威起点；结束后由持久化 work-finished 事件替代。 */
  workStartedAt: number | null
  status: AgentStatus
  busy: boolean
  /** 正在回滚的工具调用；用于 Renderer 重载后恢复不可取消的回滚活动态。 */
  checkpointRestoreToolUseId: string | null
  /** Renderer 重载时恢复会阻塞当前运行时的当前会话删除；历史删除不占用运行时。 */
  deletingSessionId: string | null
  /** Renderer 重载时恢复 Main 中尚未提交的最新导航目标。 */
  resumingSessionId: string | null
  /** 当前已经原子提交的会话；恢复中的候选会话不会提前出现在这里。 */
  sessionId: string | null
  history: ConversationHistoryWindow
  queuedInputs: QueuedUserMessage[]
  restoredInputs: QueuedUserMessage[]
  approval: ApprovalRequest | null
  /** 只重放快照之后到达 Renderer 的实时事件，避免恢复时间线与缓冲事件重复。 */
  eventSequence: number
  /** 来源证明与分支提示；不授予源会话运行时、任务或权限的所有权。 */
  forkOrigin: SessionForkOrigin | null
  /** 当前会话由 RunCommand 转入后台的任务；日志仍留在宿主，不进入 Renderer。 */
  backgroundTasks: BackgroundTaskState | null
  /** 当前父会话拥有的子代理摘要；完整 transcript 通过独立 IPC 按需读取。 */
  subagents: SubagentState | null
  activeSkills: SkillSummary[]
  turnFileChanges: ToolFileChange[]
}

/** 高频增量可短暂合并；其它事件都是必须立即交付的语义边界。 */
export function isFrameBufferedEvent(event: CoreEvent): boolean {
  return event.type === 'text-delta'
    || event.type === 'thinking-delta'
    || event.type === 'tool-progress'
    || (event.type === 'peer-event' && event.event.type === 'text-delta')
}

export interface RuntimeEventEnvelope {
  runtimeId: string
  sessionId: string | null
  sequence: number
  occurredAt: string
  event: CoreEvent
}

/** Main → Renderer 的单次有序 MessagePort 批次；批内事件仍使用全局 sequence 接续。 */
export type RuntimeEventBatch = readonly RuntimeEventEnvelope[]

export interface RuntimeCommandEnvelope {
  runtimeId: string
  command: CoreCommand
}

export interface CheckpointFilePreviewRequest {
  runtimeId: string
  toolUseId: string
  path: string
}

export interface CurrentFilePreviewRequest {
  runtimeId: string
  path: string
}

export type CheckpointFileCurrentMatchRequest = CheckpointFilePreviewRequest

export type {
  CheckpointFileCurrentMatchResult,
  CheckpointFilePreviewResult,
  CurrentFilePreviewResult,
}

export interface RuntimeCommandResult {
  ok: boolean
  /** 只读校验或命令提交失败时，可直接展示给用户的原因。 */
  error?: string
  /** 首条消息可能物化待创建的默认目录或 Worktree，Renderer 据此原子更新路径。 */
  workspace?: RuntimeWorkspace
}

export type ResumeSessionResult =
  | {
      ok: true
      snapshot: RuntimeSnapshot
    }
  | { ok: false; error: string }

export interface ForkSessionRequest {
  sourceSessionId: string
  sourceTurnId: string
}

export type ForkSessionResult = ResumeSessionResult

export type NewSessionResult =
  | { ok: true; snapshot: RuntimeSnapshot }
  | { ok: false; error: string }

export interface NewSessionRequest {
  workspace: StartWorkspaceRequest
}

export type DeleteSessionResult =
  | {
      ok: true
      deletedCurrent: boolean
      cleanupPending: boolean
      snapshot?: RuntimeSnapshot
    }
  | { ok: false; error: string; deletedCurrent?: boolean; snapshot?: RuntimeSnapshot }

export type SessionDeletionState =
  | { sessionId: string; status: 'completed' }
  | { sessionId: string; status: 'failed'; error: string }
