import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { composerDraftKey, type ComposerDraft } from './composer-drafts.ts'
import { ComposerSubmissions, prependComposerDraft, type ComposerSubmission } from './composer-submissions.ts'

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

function submission(runtimeId: string, sessionId: string | null): ComposerSubmission {
  return { runtimeId, sessionId, draft: draft('请求') }
}

function draft(text: string): ComposerDraft {
  return { text, images: [], pdfs: [], skills: [], btwMode: null, restoredInputIds: [] }
}
