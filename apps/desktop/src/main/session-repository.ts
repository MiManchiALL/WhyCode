import {
  SessionStore,
  type SessionJournal,
  type SessionMetadata,
} from '@whycode/core'

/** Electron 宿主的会话仓库：只管理当前 journal 与磁盘列表，不持有 Agent 运行态。 */
export class DesktopSessionRepository {
  private readonly store: SessionStore
  private current: SessionJournal | null = null

  constructor(storageRoot: string) {
    this.store = new SessionStore(storageRoot)
  }

  get journal(): SessionJournal | null {
    return this.current
  }

  get currentSessionId(): string | null {
    return this.current?.sessionId ?? null
  }

  async ensure(projectDir: string | null, modelId: string): Promise<SessionJournal> {
    this.current ??= await this.store.create({ projectDir, modelId })
    return this.current
  }

  async resume(sessionId: string): Promise<SessionJournal> {
    this.current = await this.store.open(sessionId)
    return this.current
  }

  reset(): void {
    this.current = null
  }

  list(projectDir?: string | null): Promise<SessionMetadata[]> {
    return this.store.list(projectDir, this.current?.metadataSnapshot)
  }

  async delete(sessionId: string): Promise<boolean> {
    if (this.current?.sessionId === sessionId) this.current = null
    return this.store.delete(sessionId)
  }
}
