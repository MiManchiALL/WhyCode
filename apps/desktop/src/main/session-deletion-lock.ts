export interface SessionDeletionLease {
  release(): void
}

/** 每个会话独立持有删除租约；同一目标不能重复删除。 */
export class SessionDeletionLock {
  private readonly active = new Map<string, SessionDeletionLease>()

  get busy(): boolean {
    return this.active.size > 0
  }

  blocksSession(sessionId?: string): boolean {
    return sessionId !== undefined && this.active.has(sessionId)
  }

  acquire(sessionId: string): SessionDeletionLease | null {
    if (this.active.has(sessionId)) return null
    const lease: SessionDeletionLease = {
      release: () => {
        if (this.active.get(sessionId) === lease) this.active.delete(sessionId)
      },
    }
    this.active.set(sessionId, lease)
    return lease
  }
}
