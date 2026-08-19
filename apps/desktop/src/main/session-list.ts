import type { SessionSummary } from '@whycode/core'
import type { SessionListItem } from '../shared/session.ts'

export interface SessionListRuntimeState {
  sessionId: string | null
  busy: boolean
}

/** 置顶顺序独立于活动时间；最近对话则保留 SessionStore 的时间顺序。 */
export function projectSessionListItems(
  summaries: readonly SessionSummary[],
  runtimes: readonly SessionListRuntimeState[],
  currentSessionId: string | null,
  pinnedSessionIds: readonly string[],
  hasUnreadCompletion: (sessionId: string) => boolean,
): SessionListItem[] {
  const summaryById = new Map(summaries.map((summary) => [summary.sessionId, summary]))
  const runtimeBySessionId = new Map(runtimes.flatMap((runtime) =>
    runtime.sessionId ? [[runtime.sessionId, runtime] as const] : []))
  const pinnedIds = new Set(pinnedSessionIds)
  const ordered = [
    ...pinnedSessionIds.flatMap((sessionId) => summaryById.get(sessionId) ?? []),
    ...summaries.filter((summary) => !pinnedIds.has(summary.sessionId)),
  ]
  return ordered.map((summary) => ({
    ...summary,
    isCurrent: summary.sessionId === currentSessionId,
    running: runtimeBySessionId.get(summary.sessionId)?.busy ?? false,
    pinned: pinnedIds.has(summary.sessionId),
    hasUnreadCompletion: hasUnreadCompletion(summary.sessionId),
  }))
}
