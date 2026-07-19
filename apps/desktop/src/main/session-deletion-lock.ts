/** 删除始终单飞；只有删除当前会话时才阻塞正在使用的运行时。 */
export class SessionDeletionLock {
  private active: { sessionId: string; blocksRuntime: boolean } | null = null

  get sessionId(): string | null {
    return this.active?.sessionId ?? null
  }

  get blocksRuntime(): boolean {
    return this.active?.blocksRuntime ?? false
  }

  acquire(sessionId: string, blocksRuntime: boolean): (() => void) | null {
    if (this.active) return null
    const lease = { sessionId, blocksRuntime }
    this.active = lease
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.active === lease) this.active = null
    }
  }
}
