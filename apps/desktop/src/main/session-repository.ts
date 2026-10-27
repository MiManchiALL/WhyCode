import {
  SessionStore,
  type PdfProcessor,
  type CustomSystemPromptSnapshot,
  type ReasoningEffortSelection,
  type SessionJournal,
  type WorkspaceBinding,
} from '@whycode/core'
import type { DesktopSessionSummary } from '../shared/session.ts'
import { preparationSummary, SessionPreparations } from './session-preparation.ts'
import { workspaceDisplayDirectory } from '../shared/workspace.ts'
import { samePath } from './workspace-path.ts'

/** Electron 宿主的持久会话仓库，涵盖工作区准备登记与 Journal，不持有选择或 Agent 运行态。 */
export class DesktopSessionRepository {
  private readonly store: SessionStore
  private readonly opened = new Map<string, SessionJournal>()
  private readonly pendingOpen = new Map<string, Promise<SessionJournal>>()
  readonly preparations: SessionPreparations

  constructor(storageRoot: string, pdfProcessor?: PdfProcessor) {
    this.store = new SessionStore(storageRoot, { pdfProcessor })
    this.preparations = new SessionPreparations(storageRoot)
  }

  async create(
    workspace: WorkspaceBinding,
    modelId: string,
    reasoningEffort: ReasoningEffortSelection = 'default',
    customSystemPrompt?: CustomSystemPromptSnapshot,
    sessionId?: string,
  ): Promise<SessionJournal> {
    const journal = await this.store.create({
      sessionId,
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
    scratchRootDirectory?: string,
  ): Promise<SessionJournal> {
    const journal = await this.store.fork(source, sourceTurnId, scratchRootDirectory)
    this.opened.set(journal.sessionId, journal)
    return journal
  }

  release(journal: SessionJournal): void {
    if (this.opened.get(journal.sessionId) === journal) {
      this.opened.delete(journal.sessionId)
    }
  }

  /** 已打开 Journal 仍拥有写入与附件事务；列表必须直接使用它们，不能并发重开。 */
  async list(
    projectDir?: string | null,
  ): Promise<DesktopSessionSummary[]> {
    const sessionIds = await this.store.listSessionIds()
    const entries = await Promise.all(sessionIds.map(async (sessionId) => {
      // 先识别宿主准备态，再读取正式记录；初始化期间不能把同一目录误判为损坏。
      const preparation = this.opened.has(sessionId)
        ? null
        : await this.preparations.read(sessionId).catch(() => null)
      if (preparation) return preparationSummary(preparation)
      return this.store.readSummary(sessionId, this.opened.get(sessionId)?.metadataSnapshot)
    }))
    return entries
      .filter((item): item is DesktopSessionSummary => item !== null)
      .filter(item => {
        if (projectDir === undefined) return true
        if (!item.workspace) return false
        const directory = workspaceDisplayDirectory(item.workspace)
        return directory === null || projectDir === null ? directory === projectDir : samePath(directory, projectDir)
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
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
