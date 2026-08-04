import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { localWorkspace } from '@whycode/core'
import { DesktopSessionRepository } from './session-repository.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('DesktopSessionRepository 生命周期', () => {
  it('每个新会话分别固化创建时传入的自定义 System', async () => {
    const repository = await createRepository()
    const first = await repository.create(
      localWorkspace('C:\\work\\demo'),
      'test:model',
      'default',
      { mode: 'append', content: '第一版' },
    )
    const second = await repository.create(
      localWorkspace('C:\\work\\demo'),
      'test:model',
      'default',
      { mode: 'replace', content: '第二版' },
    )

    assert.deepEqual(first.customSystemPrompt, { mode: 'append', content: '第一版' })
    assert.deepEqual(second.customSystemPrompt, { mode: 'replace', content: '第二版' })
  })

  it('删除会话后不再从磁盘列表返回', async () => {
    const repository = await createRepository()
    const journal = await repository.create(localWorkspace('C:\\work\\demo'), 'test:model')

    assert.equal(await repository.delete(journal.sessionId), true)
    assert.equal((await repository.list()).length, 0)
  })

  it('删除同一项目的一个会话不影响另一个会话', async () => {
    const repository = await createRepository()
    const historical = await repository.create(localWorkspace('C:\\work\\shared'), 'test:model')
    const current = await repository.create(localWorkspace('C:\\work\\shared'), 'test:model')

    assert.equal(await repository.delete(historical.sessionId), true)
    assert.deepEqual(
      (await repository.list()).map((session) => session.sessionId),
      [current.sessionId],
    )
  })

  it('候选会话打开失败时不影响已打开的会话', async () => {
    const repository = await createRepository()
    const current = await repository.create(localWorkspace('C:\\work\\one'), 'test:model')

    await assert.rejects(repository.prepareResume('not-a-session'), /无效会话 ID/)
    assert.equal((await repository.list())[0]?.sessionId, current.sessionId)
  })

  it('同一历史会话只打开一个 Journal 实例，供运行时恢复与附件协议共用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-session-repository-opened-'))
    const repository = new DesktopSessionRepository(root)
    try {
      const journal = await repository.create(localWorkspace('C:\\project'), 'model:test')
      const [first, second] = await Promise.all([
        repository.prepareResume(journal.sessionId),
        repository.prepareResume(journal.sessionId),
      ])
      assert.equal(first, second)

      repository.release(first)
      const reopened = await repository.prepareResume(journal.sessionId)
      assert.notEqual(reopened, first)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('列出会话时不重开已在内存中的后台 Journal 或清理其附件事务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-session-repository-live-list-'))
    const repository = new DesktopSessionRepository(join(root, 'sessions'))
    try {
      const foreground = await repository.create(localWorkspace('C:\\foreground'), 'model:first')
      const background = await repository.create(localWorkspace('C:\\background'), 'model:second')
      const activeAttachmentTransaction = join(
        root,
        'sessions',
        background.sessionId,
        'attachments',
        '.image-import-active',
      )
      await mkdir(activeAttachmentTransaction, { recursive: true })
      await writeFile(join(activeAttachmentTransaction, 'page.jpg'), 'still being prepared')

      const summaries = await repository.list()

      assert.deepEqual(
        new Set(summaries.map((summary) => summary.sessionId)),
        new Set([foreground.sessionId, background.sessionId]),
      )
      assert.equal(summaries.every((summary) => summary.resumable), true)
      await access(activeAttachmentTransaction)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function createRepository(): Promise<DesktopSessionRepository> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-desktop-session-'))
  tempRoots.push(root)
  return new DesktopSessionRepository(join(root, 'sessions'))
}
