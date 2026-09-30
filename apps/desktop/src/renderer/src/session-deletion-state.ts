export function isCurrentSessionDeletion(
  currentSessionId: string | null,
  targetSessionId: string,
): boolean {
  return currentSessionId === targetSessionId
}

/** 单个请求或完成事件只更新自己的目标，导航快照不能清掉其它删除。 */
export function updateDeletingSessions(
  targets: ReadonlySet<string>,
  sessionId: string,
  deleting: boolean,
): ReadonlySet<string> {
  if (targets.has(sessionId) === deleting) return targets
  const next = new Set(targets)
  if (deleting) next.add(sessionId)
  else next.delete(sessionId)
  return next
}
