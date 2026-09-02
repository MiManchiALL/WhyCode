/** sessionId 表示工作区已经绑定持久会话；对话回滚为空不改变这份所有权。 */
export function canChangeSessionWorkspace(sessionId: string | null): boolean {
  return sessionId === null
}
