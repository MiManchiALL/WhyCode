import type { SessionMetadata, ViewEvent } from '@whycode/core'

export type SessionListItem = SessionMetadata & { isCurrent: boolean }

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
