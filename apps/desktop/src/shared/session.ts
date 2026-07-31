import type {
  AgentStatus,
  ApprovalRequest,
  CoreCommand,
  CoreEvent,
  QueuedUserMessage,
  SessionMetadata,
  SessionSummary,
  ViewEvent,
  ReasoningEffortSelection,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'
import type {
  RuntimeWorkspace,
  StartWorkspaceRequest,
} from './workspace.ts'

export type SessionListItem = SessionSummary & {
  isCurrent: boolean
  /** 仅当该对话当前仍有内存运行时时存在。 */
  runtimeStatus?: AgentStatus
  running: boolean
  /** 只表示仍有审批或问题等待用户处理；普通错误结束不属于待操作。 */
  needsAttention: boolean
}

/** Renderer 可随时丢失；主进程用该快照恢复稳定界面和仍在运行的控制状态。 */
export interface RuntimeSnapshot {
  /** 对话运行时的稳定路由 ID；草稿尚未建立 JSONL 时也存在。 */
  runtimeId: string
  workspace: RuntimeWorkspace
  modelId: string | null
  reasoningEffort: ReasoningEffortSelection
  permissionMode: PermissionMode
  /** 当前连续工作的权威起点；结束后由持久化 work-finished 事件替代。 */
  workStartedAt: number | null
  status: AgentStatus
  busy: boolean
  /** 正在回滚的工具调用；用于 Renderer 重载后恢复不可取消的回滚活动态。 */
  checkpointRestoreToolUseId: string | null
  /** Renderer 重载时恢复会阻塞当前运行时的当前会话删除；历史删除不占用运行时。 */
  deletingSessionId: string | null
  /** Renderer 重载时恢复 Main 持有的会话恢复锁。 */
  resumingSessionId: string | null
  /** 当前已经原子提交的会话；恢复中的候选会话不会提前出现在这里。 */
  sessionId: string | null
  viewEvents: ViewEvent[]
  queuedInputs: QueuedUserMessage[]
  restoredInputs: QueuedUserMessage[]
  approval: ApprovalRequest | null
  /** 只重放快照之后到达 Renderer 的实时事件，避免恢复时间线与缓冲事件重复。 */
  eventSequence: number
}

export interface RuntimeEventEnvelope {
  runtimeId: string
  sessionId: string | null
  sequence: number
  event: CoreEvent
}

export interface RuntimeCommandEnvelope {
  runtimeId: string
  command: CoreCommand
}

export interface RuntimeCommandResult {
  ok: boolean
  /** 首条消息可能把待创建选择转换成真实 Worktree，Renderer 据此原子更新路径。 */
  workspace?: RuntimeWorkspace
}

export type ResumeSessionResult =
  | {
      ok: true
      snapshot: RuntimeSnapshot
    }
  | { ok: false; error: string }

export type NewSessionResult =
  | { ok: true; snapshot: RuntimeSnapshot }
  | { ok: false; error: string }

export interface NewSessionRequest {
  workspace: StartWorkspaceRequest
}

export type DeleteSessionResult =
  | { ok: true; deletedCurrent: boolean; snapshot?: RuntimeSnapshot }
  | { ok: false; error: string; deletedCurrent?: boolean; snapshot?: RuntimeSnapshot }
