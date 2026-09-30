import type { ComposerDraft } from './composer-drafts.ts'
import type { CoreEvent, QueuedUserMessage } from '@whycode/core/events'
import type { Block } from '../../shared/conversation-state.ts'

export interface ComposerSubmission {
  readonly runtimeId: string
  sessionId: string | null
  readonly draft: ComposerDraft
  readonly previousInputIds: ReadonlySet<string>
  receivedInputId?: string
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

  receiveEvent(runtimeId: string, event: CoreEvent): void {
    if (event.type === 'user-message-accepted' || event.type === 'btw-message-accepted') {
      if (event.inputId) this.receive(runtimeId, event.inputId, event.text, event.type === 'btw-message-accepted')
    } else if (event.type === 'message-queued') {
      this.receive(runtimeId, event.id, event.text, false)
    }
  }

  receiveSnapshot(runtimeId: string, blocks: readonly Block[], queued: readonly QueuedUserMessage[]): void {
    const submission = this.pending.get(runtimeId)
    if (!submission || submission.receivedInputId) return
    for (const block of blocks) {
      if (block.kind === 'user' && block.inputId) {
        this.receive(runtimeId, block.inputId, block.text, Boolean(block.btw))
      }
    }
    for (const input of queued) this.receive(runtimeId, input.id, input.text, false)
  }

  private receive(runtimeId: string, inputId: string, text: string, btw: boolean): void {
    const submission = this.pending.get(runtimeId)
    if (!submission || submission.receivedInputId || submission.previousInputIds.has(inputId)
      || submission.draft.text !== text || Boolean(submission.draft.btwMode) !== btw) return
    submission.receivedInputId = inputId
    this.publish(new Map(this.pending))
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

export function composerInputIds(blocks: readonly Block[], queued: readonly QueuedUserMessage[]): Set<string> {
  return new Set([
    ...blocks.flatMap(block => block.kind === 'user' && block.inputId ? [block.inputId] : []),
    ...queued.map(input => input.id),
  ])
}

/** 以正式输入身份接替预览；重复文本和此前排队输入都不能提前隐藏当前提交。 */
export function composerSubmissionVisible(
  submission: ComposerSubmission | undefined,
  blocks: readonly Block[],
  queued: readonly QueuedUserMessage[],
): boolean {
  if (!submission) return false
  const inputId = submission.receivedInputId
  return !inputId || (!blocks.some(block => block.kind === 'user' && block.inputId === inputId)
    && !queued.some(input => input.id === inputId))
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
