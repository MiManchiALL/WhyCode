import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ComposerDraftStore, composerDraftKey, type ComposerDraft } from './composer-drafts.ts'
import { ComposerSubmissions, composerInputIds, composerSubmissionPreview, prependComposerDraft, type ComposerSubmission } from './composer-submissions.ts'
import { applyCoreEvent, createConversationState, type Block } from '../../shared/conversation-state.ts'
import type { QueuedUserMessage } from '@whycode/core/events'

describe('跨会话提交归属', () => {
  it('切走已清空的恢复草稿后仍保存编辑身份，普通空输入不占缓存', () => {
    const store = new ComposerDraftStore()
    const empty = draft('')
    store.cache('edited', { ...empty, restoredInputIds: ['old'] })
    store.cache('blank', empty)
    assert.deepEqual(store.take('edited'), { ...empty, restoredInputIds: ['old'] })
    assert.equal(store.take('blank'), undefined)
  })

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
    assert.equal(composerSubmissionPreview(pending, previous, [])?.location, 'conversation')
    submissions.receiveEvent('runtime', { type: 'work-started', startedAt: 100 })
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'old', text: '请求' })
    submissions.receiveEvent('other', { type: 'user-message-accepted', startsTurn: true, inputId: 'new', text: '请求' })
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'unrelated', text: '另一条输入' })
    assert.equal(pending.receivedInputId, undefined)
    assert.equal(composerSubmissionPreview(pending, previous, [])?.location, 'conversation')

    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'new', text: '请求' })
    // 宿主确认与 React 消息投影可先后到达，正式气泡出现前不能留空。
    assert.equal(composerSubmissionPreview(pending, previous, [])?.location, 'conversation')
    assert.equal(composerSubmissionPreview(pending, [...previous, user('new')], []), null)
    submissions.finish(pending)
    assert.equal(composerSubmissionPreview(submissions.getSnapshot().get('runtime'), previous, []), null)
  })

  it('插话从提交起就在队列区，同文旧输入不接替它，正式注入后只在对话中显示一条', () => {
    const submissions = new ComposerSubmissions()
    const oldQueue: QueuedUserMessage = { id: 'old-queue', text: '请求' }
    const pending = {
      ...submission('runtime', 'session'), workActiveAtSubmit: true,
      previousInputIds: composerInputIds([], [oldQueue]),
    }
    submissions.start(pending)
    assert.deepEqual(composerSubmissionPreview(pending, [], [oldQueue]), { location: 'queue', draft: pending.draft })
    let view = applyCoreEvent(createConversationState(), { type: 'message-injected', ...oldQueue })
    submissions.receiveSnapshot('runtime', view.blocks, [])
    assert.equal(pending.receivedInputId, undefined)
    const queued: QueuedUserMessage = { id: 'new-queue', text: '请求' }
    submissions.receiveEvent('runtime', { type: 'message-queued', ...queued })
    view = applyCoreEvent(view, { type: 'message-queued', ...queued })
    assert.equal(composerSubmissionPreview(pending, view.blocks, [])?.location, 'queue')
    assert.equal(composerSubmissionPreview(pending, view.blocks, [queued]), null)
    assert.deepEqual(view.blocks.filter(block => block.kind === 'user').map(block => block.inputId), [oldQueue.id])
    view = applyCoreEvent(view, { type: 'message-injected', ...queued })
    assert.equal(composerSubmissionPreview(pending, view.blocks, []), null)
    assert.deepEqual(view.blocks.filter(block => block.kind === 'user').map(block => block.inputId), [oldQueue.id, queued.id])
  })

  it('提交期间原工作结束时，宿主确认的新根消息直接接替队列区预览', () => {
    const submissions = new ComposerSubmissions()
    const pending = { ...submission('runtime', 'session'), workActiveAtSubmit: true }
    submissions.start(pending)
    submissions.receiveEvent('runtime', { type: 'work-finished', durationMs: 100, outcome: 'completed', forkTurnId: 'old' })
    assert.equal(composerSubmissionPreview(pending, [], [])?.location, 'queue')
    const blocks = [user('new-root')]
    submissions.receiveSnapshot('runtime', blocks, [])
    assert.equal(composerSubmissionPreview(pending, blocks, []), null)
  })

  it('切回后台提交时可由快照接替；迟到的旧输入不匹配同文的新提交', () => {
    const submissions = new ComposerSubmissions()
    const pending = submission('runtime', 'session')
    const other = { ...submission('other', 'other-session'), workActiveAtSubmit: true }
    submissions.start(pending)
    submissions.start(other)
    submissions.receiveSnapshot('runtime', [user('first')], [])
    assert.equal(composerSubmissionPreview(pending, [user('first')], []), null)
    assert.equal(composerSubmissionPreview(other, [], [])?.location, 'queue')
    const queue = [{ id: 'queued', text: '请求' }]
    submissions.receiveSnapshot('other', [], queue)
    assert.equal(composerSubmissionPreview(other, [], queue), null)
    submissions.finish(pending)
    const next = { ...submission('runtime', 'session'), previousInputIds: composerInputIds([user('first')], []) }
    submissions.start(next)
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'first', text: '请求' })
    assert.equal(composerSubmissionPreview(next, [user('first')], [])?.location, 'conversation')
    submissions.receiveSnapshot('runtime', [user('first'), user('second')], [])
    assert.equal(composerSubmissionPreview(next, [user('first'), user('second')], []), null)
  })

  it('BTW 的预览只由对应的旁路消息接替', () => {
    const submissions = new ComposerSubmissions()
    const pending = submission('runtime', 'session')
    pending.draft.btwMode = 'btw'
    submissions.start(pending)
    assert.equal(composerSubmissionPreview(pending, [], [])?.location, 'conversation')
    submissions.receiveEvent('runtime', { type: 'user-message-accepted', startsTurn: true, inputId: 'main', text: '请求' })
    assert.equal(pending.receivedInputId, undefined)
    const btw = { ...user('side'), btw: { conversationId: 'btw', turnIndex: 0, mode: 'btw' as const } }
    submissions.receiveSnapshot('runtime', [btw], [])
    assert.equal(composerSubmissionPreview(pending, [btw], []), null)
  })
})

function user(inputId: string): Extract<Block, { kind: 'user' }> {
  return { kind: 'user', id: `user-${inputId}`, inputId, text: '请求' }
}

function submission(runtimeId: string, sessionId: string | null): ComposerSubmission {
  return {
    runtimeId, sessionId, draft: draft('请求'), workActiveAtSubmit: false,
    previousInputIds: new Set(), abortController: new AbortController(),
  }
}

function draft(text: string): ComposerDraft {
  return { text, images: [], pdfs: [], skills: [], btwMode: null, restoredInputIds: [] }
}
