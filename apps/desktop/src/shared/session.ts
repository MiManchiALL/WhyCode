import type {
  AgentStatus,
  ApprovalRequest,
  CoreEvent,
  SessionMetadata,
  ViewEvent,
} from '@whycode/core'

export type SessionListItem = SessionMetadata & { isCurrent: boolean }

/** Renderer 可随时丢失；主进程用该快照恢复稳定界面和仍在运行的控制状态。 */
export interface RuntimeSnapshot {
  projectDir: string | null
  modelId: string | null
  status: AgentStatus
  busy: boolean
  viewEvents: ViewEvent[]
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
      recoveredFromInterruption: boolean
    }
  | { ok: false; error: string }

export interface SessionActionResult {
  ok: boolean
  error?: string
}

export type DeleteSessionResult =
  | { ok: true; deletedCurrent: boolean }
  | { ok: false; error: string }
