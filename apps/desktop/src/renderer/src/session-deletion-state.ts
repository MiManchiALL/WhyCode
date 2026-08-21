export function isCurrentSessionDeletion(
  currentSessionId: string | null,
  targetSessionId: string,
): boolean {
  return currentSessionId === targetSessionId
}

/** 切换会话的快照只描述“是否删除当前会话”，不能清掉 Renderer 正在跟踪的历史删除。 */
export function preserveDeletionTarget(
  localTarget: string | null,
  snapshotTarget: string | null,
): string | null {
  return localTarget ?? snapshotTarget
}
