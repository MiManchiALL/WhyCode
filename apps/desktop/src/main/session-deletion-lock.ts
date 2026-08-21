export interface SessionDeletionLease {
  /** 当前会话已经安全切到替代运行时；只继续锁定被删除的目标。 */
  allowRuntimeChanges(): void
  release(): void
}

/** 删除始终单飞；当前会话只在替代运行时提交前阻塞全局切换。 */
export class SessionDeletionLock {
  private active: { sessionId: string; blocksRuntime: boolean } | null = null

  get sessionId(): string | null {
    return this.active?.sessionId ?? null
  }

  get blocksRuntime(): boolean {
    return this.active?.blocksRuntime ?? false
  }

  /** 历史会话删除只排斥同一会话；删除当前会话时才冻结会话切换。 */
  blocksSession(sessionId?: string): boolean {
    if (!this.active) return false
    return this.active.blocksRuntime
      || (sessionId !== undefined && this.active.sessionId === sessionId)
  }

  acquire(sessionId: string, blocksRuntime: boolean): SessionDeletionLease | null {
    if (this.active) return null
    const lease = { sessionId, blocksRuntime }
    this.active = lease
    let released = false
    return {
      allowRuntimeChanges: () => {
        if (!released && this.active === lease) lease.blocksRuntime = false
      },
      release: () => {
        if (released) return
        released = true
        if (this.active === lease) this.active = null
      },
    }
  }
}
