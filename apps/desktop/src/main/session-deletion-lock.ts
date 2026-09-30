export interface SessionDeletionLease {
  release(): void
}

/** 删除始终单飞，只锁定目标会话，远端清理期间仍可操作其它会话。 */
export class SessionDeletionLock {
  private active: { sessionId: string } | null = null

  get sessionId(): string | null {
    return this.active?.sessionId ?? null
  }

  blocksSession(sessionId?: string): boolean {
    return sessionId !== undefined && this.active?.sessionId === sessionId
  }

  acquire(sessionId: string): SessionDeletionLease | null {
    if (this.active) return null
    const lease = { sessionId }
    this.active = lease
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        if (this.active === lease) this.active = null
      },
    }
  }
}
