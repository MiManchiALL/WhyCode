import type { SessionListItem } from '../../shared/session.ts'

export function isCurrentSessionDeletion(
  sessions: readonly Pick<SessionListItem, 'sessionId' | 'isCurrent'>[],
  sessionId: string,
): boolean {
  return sessions.some((session) => session.sessionId === sessionId && session.isCurrent)
}
