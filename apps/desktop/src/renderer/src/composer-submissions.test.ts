import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { composerDraftKey, type ComposerDraft } from './composer-drafts.ts'
import { ComposerSubmissions, composerInputIds, composerSubmissionVisible, prependComposerDraft, type ComposerSubmission } from './composer-submissions.ts'
import type { Block } from '../../shared/conversation-state.ts'
import type { QueuedUserMessage } from '@whycode/core/events'

describe('跨会话提交归属', () => {
  it('Worktree 创建未完成时，另一会话可独立提交，源请求结束不解除另一请求', () => {
    const submissions = new ComposerSubmissions()
    const creating = submission('creating', null)
    const history = submission('history', 'saved-history')
    submissions.start(creating)
    submissions.start(history)
    assert.throws(() => submissions.start(submission('creating', null)), /仍有消息正在提交/u)

    submissions.finish(creating)
    assert.equal(submissions.getSnapshot().has('creating'), false)
    assert.equal(submissions.getSnapshot().get('history'), history)
    submissions.finish(history)
    assert.equal(submissions.getSnapshot().size, 0)
  })

  it('后台首次落盘只绑定源提交；新草稿和迟到的完成通知不能相互覆盖', () => {
    const submissions = new ComposerSubmissions()
    const creating = submission('creating', null)
    submissions.start(creating)
    assert.equal(submissions.bindSession('creating', 'saved-created'), true)
    assert.equal(creating.sessionId, 'saved-created')
    assert.equal(submissions.bindSession('creating', 'saved-created'), false)
    assert.notEqual(composerDraftKey('creating', null), composerDraftKey('new-draft', null))
    assert.equal(composerDraftKey('reloaded-runtime', 'saved-created'), 'saved-created')

    submissions.finish(creating)
    const next = submission('creating', 'saved-created')
    submissions.start(next)
    submissions.finish(creating)
    assert.equal(submissions.getSnapshot().get('creating'), next)
  })

  it('失败恢复保留源消息、继续编辑的附件和所选 Skill，恢复队列不重复', () => {
    const sent: ComposerDraft = {
      ...draft('源消息'),
      images: [{ id: 'image', name: '图.png', kind: 'stored', attachmentId: 'attachment', sessionId: 'session', storageName: '图.png', previewUrl: 'whycode-attachment://session/图.png' }],
      pdfs: [{ id: 'pdf', name: '说明.pdf', kind: 'path', path: 'C:/fixtures/说明.pdf', byteLength: 30 }],
      skills: [{ id: 'skill', name: 'test-skill', description: '测试', scope: 'user', path: 'C:/skills/test/SKILL.md', rootPath: 'C:/skills/test' }],
      restoredInputIds: ['input-1'],
    }
    const current: ComposerDraft = { ...draft('后续输入'), skills: sent.skills, restoredInputIds: ['input-1', 'input-2'] }
    const restored = prependComposerDraft(sent, current)
    assert.equal(restored.text, '源消息\n后续输入')
    assert.equal(restored.images[0], sent.images[0])
    assert.equal(restored.pdfs[0], sent.pdfs[0])
    assert.deepEqual(restored.skills, sent.skills)
    assert.deepEqual(restored.restoredInputIds, ['input-1', 'input-2'])
    assert.equal(sent.text, '源消息')
    assert.equal(current.text, '后续输入')
  })
})

describe('提交消息的即时展示', () => {
  it('宿主准备未完成时立即显示；计时、工具事件及重复文本的旧消息不能提前接替', () => {
    const submissions = new ComposerSubmissions()
    const previous = [user('old')]
    const pending = { ...submission('runtime', 'session'), previousInputIds: composerInputIds(previous, []) }
    submissions.start(pending)
    assert.equal(composerSubmissionVisible(pending, previous, []), true)
    submissions.receiveEvent('runtime', { type: 'work-started', startedAt: 100 })
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'old', text: '请求' })
    submissions.receiveEvent('other', { type: 'user-message-accepted', startsTurn: true, inputId: 'new', text: '请求' })
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'unrelated', text: '另一条输入' })
    assert.equal(pending.receivedInputId, undefined)
    assert.equal(composerSubmissionVisible(pending, previous, []), true)

    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'new', text: '请求' })
    // 宿主确认与 React 消息投影可先后到达，正式气泡出现前不能留空。
    assert.equal(composerSubmissionVisible(pending, previous, []), true)
    assert.equal(composerSubmissionVisible(pending, [...previous, user('new')], []), false)
    submissions.finish(pending)
    assert.equal(composerSubmissionVisible(submissions.getSnapshot().get('runtime'), previous, []), false)
  })

  it('正在排队的旧输入注入主线不影响当前提交，新队列卡片到达后接替预览', () => {
    const submissions = new ComposerSubmissions()
    const oldQueue: QueuedUserMessage = { id: 'old-queue', text: '请求' }
    const pending = { ...submission('runtime', 'session'), previousInputIds: composerInputIds([], [oldQueue]) }
    submissions.start(pending)
    submissions.receiveSnapshot('runtime', [user('old-queue')], [])
    assert.equal(composerSubmissionVisible(pending, [user('old-queue')], []), true)
    const queued: QueuedUserMessage = { id: 'new-queue', text: '请求' }
    submissions.receiveSnapshot('runtime', [user('old-queue')], [queued])
    assert.equal(composerSubmissionVisible(pending, [user('old-queue')], []), true)
    assert.equal(composerSubmissionVisible(pending, [user('old-queue')], [queued]), false)
  })

  it('切回后台提交时可由快照接替；迟到的旧输入不匹配同文的新提交', () => {
    const submissions = new ComposerSubmissions()
    const pending = submission('runtime', 'session')
    const other = submission('other', 'other-session')
    submissions.start(pending)
    submissions.start(other)
    submissions.receiveSnapshot('runtime', [user('first')], [])
    assert.equal(composerSubmissionVisible(pending, [user('first')], []), false)
    assert.equal(composerSubmissionVisible(other, [], []), true)
    submissions.finish(pending)
    const next = { ...submission('runtime', 'session'), previousInputIds: composerInputIds([user('first')], []) }
    submissions.start(next)
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'first', text: '请求' })
    assert.equal(composerSubmissionVisible(next, [user('first')], []), true)
    submissions.receiveSnapshot('runtime', [user('first'), user('second')], [])
    assert.equal(composerSubmissionVisible(next, [user('first'), user('second')], []), false)
  })

  it('BTW 的预览只由对应的旁路消息接替', () => {
    const submissions = new ComposerSubmissions()
    const pending = submission('runtime', 'session')
    pending.draft.btwMode = 'btw'
    submissions.start(pending)
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'main', text: '请求' })
    assert.equal(pending.receivedInputId, undefined)
    const btw = { ...user('side'), btw: { conversationId: 'btw', turnIndex: 0, mode: 'btw' as const } }
    submissions.receiveSnapshot('runtime', [btw], [])
    assert.equal(composerSubmissionVisible(pending, [btw], []), false)
  })
})

function user(inputId: string): Extract<Block, { kind: 'user' }> {
  return { kind: 'user', id: `user-${inputId}`, inputId, text: '请求' }
}

function submission(runtimeId: string, sessionId: string | null): ComposerSubmission {
  return { runtimeId, sessionId, draft: draft('请求'), previousInputIds: new Set() }
}

function draft(text: string): ComposerDraft {
  return { text, images: [], pdfs: [], skills: [], btwMode: null, restoredInputIds: [] }
}
