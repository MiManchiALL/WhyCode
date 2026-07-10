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

describe('DesktopSessionRepository 删除语义', () => {
  it('删除当前会话后解除当前 journal', async () => {
    const repository = await createRepository()
    const journal = await repository.ensure('C:\\work\\demo', 'test:model')

    assert.equal(await repository.delete(journal.sessionId), true)
    assert.equal(repository.currentSessionId, null)
  })

  it('删除历史会话不影响当前会话', async () => {
    const repository = await createRepository()
    const historical = await repository.ensure('C:\\work\\old', 'test:model')
    repository.reset()
    const current = await repository.ensure('C:\\work\\current', 'test:model')

    assert.equal(await repository.delete(historical.sessionId), true)
    assert.equal(repository.currentSessionId, current.sessionId)
  })
})

async function createRepository(): Promise<DesktopSessionRepository> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-desktop-session-'))
  tempRoots.push(root)
  return new DesktopSessionRepository(root, join(root, '..', 'checkpoints'))
}
