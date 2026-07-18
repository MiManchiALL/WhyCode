/** Main 进程内的会话恢复单飞锁；lease 只允许释放自己取得的那一次恢复。 */
export class SessionResumeLock {
  private activeId: string | null = null

  get sessionId(): string | null {
    return this.activeId
  }

  acquire(sessionId: string): (() => void) | null {
    if (this.activeId) return null
    this.activeId = sessionId
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.activeId === sessionId) this.activeId = null
    }
  }
}
