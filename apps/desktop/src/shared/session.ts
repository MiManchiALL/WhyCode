import type { SessionMetadata } from '@whycode/core'

export type ResumeSessionResult =
  | {
      ok: true
      session: SessionMetadata
      messageCount: number
      recoveredFromInterruption: boolean
    }
  | { ok: false; error: string }

export interface SessionActionResult {
  ok: boolean
  error?: string
}
