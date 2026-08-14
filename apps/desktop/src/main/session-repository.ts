import {
  SessionStore,
  type PdfProcessor,
  type CustomSystemPromptSnapshot,
  type ReasoningEffortSelection,
  type SessionJournal,
  type SessionSummary,
  type WorkspaceBinding,
} from '@whycode/core'

/** Electron 宿主的会话仓库：只管理磁盘 Journal，不持有选择或 Agent 运行态。 */
export class DesktopSessionRepository {
  private readonly store: SessionStore
  private readonly opened = new Map<string, SessionJournal>()
  private readonly pendingOpen = new Map<string, Promise<SessionJournal>>()

  constructor(storageRoot: string, pdfProcessor?: PdfProcessor) {
    this.store = new SessionStore(storageRoot, { pdfProcessor })
  }

  async create(
    workspace: WorkspaceBinding,
    modelId: string,
    reasoningEffort: ReasoningEffortSelection = 'default',
    customSystemPrompt?: CustomSystemPromptSnapshot,
  ): Promise<SessionJournal> {
    const journal = await this.store.create({
      workspace,
      modelId,
      reasoningEffort,
      customSystemPrompt,
    })
    this.opened.set(journal.sessionId, journal)
    return journal
  }

  /** 完整打开候选会话；并发请求复用同一个 Journal 实例。 */
  prepareResume(sessionId: string): Promise<SessionJournal> {
    const opened = this.opened.get(sessionId)
    if (opened) return Promise.resolve(opened)
    const pending = this.pendingOpen.get(sessionId)
    if (pending) return pending
    let opening: Promise<SessionJournal>
    opening = this.store.open(sessionId)
      .then((journal) => {
        this.opened.set(sessionId, journal)
        return journal
      })
      .finally(() => {
        if (this.pendingOpen.get(sessionId) === opening) {
          this.pendingOpen.delete(sessionId)
        }
      })
    this.pendingOpen.set(sessionId, opening)
    return opening
  }

  async fork(
    source: SessionJournal,
    sourceTurnId: string,
    targetWorkspace: WorkspaceBinding,
  ): Promise<SessionJournal> {
    const journal = await this.store.fork(source, sourceTurnId, targetWorkspace)
    this.opened.set(journal.sessionId, journal)
    return journal
  }

  release(journal: SessionJournal): void {
    if (this.opened.get(journal.sessionId) === journal) {
      this.opened.delete(journal.sessionId)
    }
  }

  /** 已打开 Journal 仍拥有写入与附件事务；列表必须直接使用它们，不能并发重开。 */
  list(
    projectDir?: string | null,
  ): Promise<SessionSummary[]> {
    return this.store.list(
      projectDir,
      [...this.opened.values()].map((journal) => journal.metadataSnapshot),
    )
  }

  async markDeleting(sessionId: string): Promise<boolean> {
    const marked = await this.store.markDeleting(sessionId)
    if (marked) this.opened.delete(sessionId)
    return marked
  }

  async delete(sessionId: string): Promise<boolean> {
    const deleted = await this.store.delete(sessionId)
    if (deleted) this.opened.delete(sessionId)
    return deleted
  }
}
