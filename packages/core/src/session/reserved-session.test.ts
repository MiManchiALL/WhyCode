import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { SessionStore } from './store.ts'
import { getSessionPaths } from './metadata.ts'

it('宿主登记的会话身份沿用到 Journal，重复创建不能覆盖已写入历史', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-reserved-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const store = new SessionStore(root)
  const sessionId = randomUUID()
  const input = { sessionId, workspace: { mode: 'none' as const }, modelId: 'test:model' }
  const journal = await store.create(input)
  assert.equal(journal.sessionId, sessionId)
  const path = getSessionPaths(root, sessionId).transcript
  const original = await readFile(path, 'utf8')
  await assert.rejects(store.create(input), /EEXIST/)
  assert.equal(await readFile(path, 'utf8'), original)
  await store.markDeleting(sessionId)
  await assert.rejects(store.create(input), /删除未完成/)
  await assert.rejects(store.create({ ...input, sessionId: '../outside' }), /无效会话 ID/)
})
