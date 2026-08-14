export type SessionPreparationKind = 'resume' | 'fork'

/**
 * Main 进程内的会话物化单飞锁；lease 只允许释放自己取得的那次操作。
 */
export class SessionPreparationLock {
  private activeId: string | null = null
  private activeKind: SessionPreparationKind | null = null

  get sessionId(): string | null {
    return this.activeId
  }

  get kind(): SessionPreparationKind | null {
    return this.activeKind
  }

  /** Fork 不是恢复动作，不应让 Renderer 误标源会话正在恢复。 */
  get visibleResumeSessionId(): string | null {
    return this.activeKind === 'resume' ? this.activeId : null
  }

  acquire(
    sessionId: string,
    kind: SessionPreparationKind = 'resume',
  ): (() => void) | null {
    if (this.activeId) return null
    this.activeId = sessionId
    this.activeKind = kind
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.activeId !== sessionId) return
      this.activeId = null
      this.activeKind = null
    }
  }
}
