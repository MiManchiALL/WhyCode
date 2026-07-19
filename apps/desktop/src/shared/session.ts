import type {
  AgentStatus,
  ApprovalRequest,
  CoreEvent,
  QueuedUserMessage,
  SessionMetadata,
  SessionSummary,
  ViewEvent,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'

export type SessionListItem = SessionSummary & { isCurrent: boolean }

/** Renderer 可随时丢失；主进程用该快照恢复稳定界面和仍在运行的控制状态。 */
export interface RuntimeSnapshot {
  projectDir: string | null
  modelId: string | null
  permissionMode: PermissionMode
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
  sequence: number
  event: CoreEvent
}

export type ResumeSessionResult =
  | {
      ok: true
      session: SessionMetadata
      viewEvents: ViewEvent[]
      queuedInputs: QueuedUserMessage[]
      restoredInputs: QueuedUserMessage[]
      recoveredFromInterruption: boolean
    }
  | { ok: false; error: string }

export type NewSessionResult =
  | { ok: true; projectDir: string }
  | { ok: false; error: string }

export type DeleteSessionResult =
  | { ok: true; deletedCurrent: boolean }
  | { ok: false; error: string; deletedCurrent?: boolean }
