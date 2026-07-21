export function isCurrentSessionDeletion(
  currentSessionId: string | null,
  targetSessionId: string,
): boolean {
  return currentSessionId === targetSessionId
}
