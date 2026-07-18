import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DesktopSessionRepository } from './session-repository.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('DesktopSessionRepository 生命周期', () => {
  it('并发确保首次会话时只创建一个 journal', async () => {
    const repository = await createRepository()

    const [first, second] = await Promise.all([
      repository.ensure('C:\\work\\demo', 'test:model'),
      repository.ensure('C:\\work\\demo', 'test:model'),
    ])

    assert.equal(first, second)
    assert.equal((await repository.list()).length, 1)
  })

  it('删除当前会话后解除当前 journal', async () => {
    const repository = await createRepository()
    const journal = await repository.ensure('C:\\work\\demo', 'test:model')

    assert.equal(await repository.delete(journal.sessionId), true)
    assert.equal(repository.currentSessionId, null)
  })

  it('删除同一项目的历史会话不影响当前会话', async () => {
    const repository = await createRepository()
    const historical = await repository.ensure('C:\\work\\shared', 'test:model')
    repository.reset()
    const current = await repository.ensure('C:\\work\\shared', 'test:model')

    assert.equal(await repository.delete(historical.sessionId), true)
    assert.equal(repository.currentSessionId, current.sessionId)
  })

  it('候选会话只有显式 activate 后才替换当前会话', async () => {
    const repository = await createRepository()
    const first = await repository.ensure('C:\\work\\one', 'test:model')
    repository.reset()
    const second = await repository.ensure('C:\\work\\two', 'test:model')
    repository.reset()
    repository.activate(first)

    const candidate = await repository.prepareResume(second.sessionId)
    assert.equal(repository.currentSessionId, first.sessionId)

    repository.activate(candidate)
    assert.equal(repository.currentSessionId, second.sessionId)
  })

  it('候选会话打开失败时保留当前会话', async () => {
    const repository = await createRepository()
    const current = await repository.ensure('C:\\work\\one', 'test:model')

    await assert.rejects(repository.prepareResume('not-a-session'), /无效会话 ID/)
    assert.equal(repository.currentSessionId, current.sessionId)
  })
})

async function createRepository(): Promise<DesktopSessionRepository> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-desktop-session-'))
  tempRoots.push(root)
  return new DesktopSessionRepository(join(root, 'sessions'))
}
