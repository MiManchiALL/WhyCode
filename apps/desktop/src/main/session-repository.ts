import {
  SessionStore,
  type PdfProcessor,
  type CustomSystemPromptSnapshot,
  type ReasoningEffortSelection,
  type SessionJournal,
  type SessionSummary,
} from '@whycode/core'

/** Electron 宿主的会话仓库：只管理当前 journal 与磁盘列表，不持有 Agent 运行态。 */
export class DesktopSessionRepository {
  private readonly store: SessionStore
  private current: SessionJournal | null = null
  private pendingCreate: Promise<SessionJournal> | null = null
  private generation = 0

  constructor(storageRoot: string, pdfProcessor?: PdfProcessor) {
    this.store = new SessionStore(storageRoot, { pdfProcessor })
  }

  get journal(): SessionJournal | null {
    return this.current
  }

  get currentSessionId(): string | null {
    return this.current?.sessionId ?? null
  }

  async ensure(
    projectDir: string | null,
    modelId: string,
    reasoningEffort: ReasoningEffortSelection = 'default',
    customSystemPrompt?: CustomSystemPromptSnapshot,
  ): Promise<SessionJournal> {
    if (this.current) return this.current
    if (!this.pendingCreate) {
      const generation = this.generation
      const create = this.store.create({
        projectDir,
        modelId,
        reasoningEffort,
        customSystemPrompt,
      }).then(async (journal) => {
        if (generation !== this.generation) {
          await this.store.delete(journal.sessionId).catch(() => false)
          throw new Error('会话初始化已失效')
        }
        this.current ??= journal
        return this.current
      })
      let pending: Promise<SessionJournal>
      pending = create.finally(() => {
        if (this.pendingCreate === pending) this.pendingCreate = null
      })
      this.pendingCreate = pending
    }
    return this.pendingCreate
  }

  /** 完整打开候选会话，但在 Main 原子提交前不替换当前 journal。 */
  prepareResume(sessionId: string): Promise<SessionJournal> {
    return this.store.open(sessionId)
  }

  activate(journal: SessionJournal): void {
    this.generation++
    this.pendingCreate = null
    this.current = journal
  }

  reset(): void {
    this.generation++
    this.pendingCreate = null
    this.current = null
  }

  list(projectDir?: string | null): Promise<SessionSummary[]> {
    return this.store.list(projectDir, this.current?.metadataSnapshot)
  }

  async markDeleting(sessionId: string): Promise<boolean> {
    const marked = await this.store.markDeleting(sessionId)
    if (marked && this.current?.sessionId === sessionId) this.current = null
    return marked
  }

  async delete(sessionId: string): Promise<boolean> {
    const deletingCurrent = this.current?.sessionId === sessionId
    const deleted = await this.store.delete(sessionId)
    if (deleted && deletingCurrent) this.current = null
    return deleted
  }
}
