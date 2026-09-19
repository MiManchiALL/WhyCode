import type { ComposerDraft } from './composer-drafts.ts'

export interface ComposerSubmission {
  readonly runtimeId: string
  sessionId: string | null
  readonly draft: ComposerDraft
  /** 切走后暂存继续编辑的输入；提交完成前不能被普通草稿缓存淘汰。 */
  remainder?: ComposerDraft
  readonly worktreeBaseRef?: string | null
}

/** 尚未收到宿主确认的输入归发起运行时持有，不随当前选中会话切换。 */
export class ComposerSubmissions {
  private pending: ReadonlyMap<string, ComposerSubmission> = new Map()
  private readonly listeners = new Set<() => void>()

  getSnapshot = (): ReadonlyMap<string, ComposerSubmission> => this.pending

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(submission: ComposerSubmission): void {
    if (this.pending.has(submission.runtimeId)) throw new Error('该会话仍有消息正在提交')
    this.publish(new Map(this.pending).set(submission.runtimeId, submission))
  }

  bindSession(runtimeId: string, sessionId: string): boolean {
    const submission = this.pending.get(runtimeId)
    if (!submission || submission.sessionId !== null) return false
    // 请求闭包与事件流共用同一身份；迟到的确认和失败恢复也必须使用正式会话草稿。
    submission.sessionId = sessionId
    return true
  }

  finish(submission: ComposerSubmission): void {
    if (this.pending.get(submission.runtimeId) !== submission) return
    const next = new Map(this.pending)
    next.delete(submission.runtimeId)
    this.publish(next)
  }

  private publish(pending: ReadonlyMap<string, ComposerSubmission>): void {
    this.pending = pending
    for (const listener of this.listeners) listener()
  }
}

export function prependComposerDraft(sent: ComposerDraft, current?: ComposerDraft): ComposerDraft {
  if (!current) return sent
  return {
    text: [sent.text, current.text].filter(Boolean).join('\n'),
    images: [...sent.images, ...current.images],
    pdfs: [...sent.pdfs, ...current.pdfs],
    skills: [...new Map([...sent.skills, ...current.skills].map(skill => [skill.id, skill])).values()],
    btwMode: sent.btwMode ?? current.btwMode,
    restoredInputIds: [...new Set([...sent.restoredInputIds, ...current.restoredInputIds])],
  }
}
