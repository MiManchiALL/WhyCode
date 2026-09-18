import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { localWorkspace, type SessionJournal, type WorkspaceBinding } from '@whycode/core'
import { cleanupSessionWorkspace, stageSessionDeletion } from './session-deletion.ts'
import { DesktopSessionRepository } from './session-repository.ts'
import { SessionScratchManager } from './session-scratch.ts'
import { ManagedWorkspaceManager } from './workspace.ts'

const roots: string[] = []
const unusedWorktrees = { detachSession: async () => { assert.fail('不应清理无关 Worktree') } }

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('删除会话与项目目录归属', () => {
  it('旧受管记录不阻塞 Local 删除，已经中断的删除可重试并从列表消失', async () => {
    const fixture = await createFixture()
    const { root, sessions, managed, manifests } = fixture
    const unrelated = await managed.create(randomUUID())
    const manifestPath = join(manifests, `${unrelated.id}.json`)
    const unsupported = JSON.stringify({ schemaVersion: 1 })
    await writeFile(manifestPath, unsupported)
    await writeFile(join(unrelated.workingDirectory, 'keep.txt'), 'unrelated')
    const project = join(root, 'project')
    await mkdir(project)
    await writeFile(join(project, 'keep.txt'), 'user project')
    const journal = await sessions.create(localWorkspace(project), 'test:model')
    await sessions.markDeleting(journal.sessionId)
    assert.equal((await sessions.list())[0]?.resumable, false)

    assert.deepEqual(await deleteJournal(fixture, journal, localWorkspace(project)), { deleted: true })
    assert.deepEqual(await sessions.list(), [])
    await assertDeleted(fixture, journal)
    assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'user project')
    assert.equal(await readFile(join(unrelated.workingDirectory, 'keep.txt'), 'utf8'), 'unrelated')
    assert.equal(await readFile(manifestPath, 'utf8'), unsupported)
  })

  for (const manifestState of ['unsupported', 'malformed', 'missing'] as const) {
    it(`受管清单 ${manifestState} 时拒绝恢复、删除历史并明确保留项目文件`, async () => {
      const fixture = await createFixture()
      const { sessions, managed, manifests } = fixture
      const workspace = await managed.create(randomUUID())
      const journal = await sessions.create(workspace, 'test:model')
      await managed.attachSession(workspace, journal.sessionId)
      const file = join(workspace.workingDirectory, 'keep.txt')
      const manifestPath = join(manifests, `${workspace.id}.json`)
      await writeFile(file, 'project')
      if (manifestState === 'missing') await rm(manifestPath)
      else await writeFile(manifestPath, manifestState === 'unsupported' ? '{"schemaVersion":1}' : '{')
      await assert.rejects(managed.assertUsable(workspace, journal.sessionId))

      const result = await deleteJournal(fixture, journal, workspace)
      assert.equal(result.deleted, true)
      assert.match(result.warning ?? '', /项目文件已保留/)
      await assertDeleted(fixture, journal)
      assert.deepEqual(await sessions.list(), [])
      assert.equal(await readFile(file, 'utf8'), 'project')
      if (manifestState === 'missing') await assert.rejects(access(manifestPath), /ENOENT/)
      else assert.equal(await readFile(manifestPath, 'utf8'), manifestState === 'unsupported' ? '{"schemaVersion":1}' : '{')
    })
  }

  it('完全不可读的历史仍可删除，不从旧数据猜测目录归属', async () => {
    const fixture = await createFixture()
    const { root, sessions, managed, manifests } = fixture
    const workspace = await managed.create(randomUUID())
    const journal = await sessions.create(workspace, 'test:model')
    await writeFile(join(workspace.workingDirectory, 'keep.txt'), 'unknown owner')
    await writeFile(join(manifests, `${workspace.id}.json`), '{"schemaVersion":1}')
    sessions.release(journal)
    await writeFile(join(root, 'sessions', journal.sessionId, 'transcript.jsonl'), '{\n')
    await rm(join(root, 'sessions', journal.sessionId, 'metadata.json'))
    const [summary] = await sessions.list()
    assert.equal(summary?.resumable, false)
    assert.equal(summary?.workspace, undefined)
    const result = await deleteJournal(fixture, journal, summary?.workspace)
    assert.equal(result.deleted, true)
    assert.match(result.warning ?? '', /无法确认工作区归属/)
    assert.deepEqual(await sessions.list(), [])
    await assertDeleted(fixture, journal)
    assert.equal(await readFile(join(workspace.workingDirectory, 'keep.txt'), 'utf8'), 'unknown owner')
  })

  it('归属不一致时保留项目，删除历史后重启也不能回收未释放的目录', async () => {
    const fixture = await createFixture()
    const { sessions, managed, manifests } = fixture
    const workspace = await managed.create(randomUUID())
    const journal = await sessions.create(workspace, 'test:model')
    await managed.attachSession(workspace, journal.sessionId)
    const file = join(workspace.workingDirectory, 'keep.txt')
    await writeFile(file, 'unverified project')
    const manifestPath = join(manifests, `${workspace.id}.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.createdAt = new Date(Date.parse(manifest.createdAt) + 1).toISOString()
    await writeFile(manifestPath, JSON.stringify(manifest))

    const result = await deleteJournal(fixture, journal, workspace)
    assert.equal(result.deleted, true)
    assert.match(result.warning ?? '', /项目文件已保留/)
    assert.deepEqual(await sessions.list(), [])
    const restarted = new ManagedWorkspaceManager(managed.rootDirectory, manifests)
    assert.deepEqual(await restarted.cleanupAbandoned([], new Set()), { removed: [], warnings: [] })
    assert.equal(await readFile(file, 'utf8'), 'unverified project')
    assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).sessionIds, [journal.sessionId])
  })

  it('有效共享清单保留其它分支，删除最后引用才清理目录', async () => {
    const fixture = await createFixture()
    const { sessions, managed } = fixture
    const workspace = await managed.create(randomUUID())
    const source = await sessions.create(workspace, 'test:model')
    const fork = await sessions.create(workspace, 'test:model')
    await managed.attachSession(workspace, source.sessionId)
    await managed.attachSession(workspace, fork.sessionId)
    await writeFile(join(workspace.workingDirectory, 'keep.txt'), 'shared')
    assert.deepEqual(await deleteJournal(fixture, source, workspace), { deleted: true })
    await managed.assertUsable(workspace, fork.sessionId)
    assert.deepEqual((await sessions.list()).map(item => item.sessionId), [fork.sessionId])
    assert.deepEqual(await deleteJournal(fixture, fork, workspace), { deleted: true })
    await assert.rejects(access(workspace.workingDirectory), /ENOENT/)
    assert.deepEqual(await sessions.list(), [])
  })

  it('历史不可读时仍按有效外置清单释放目标引用，无关坏清单不影响它', async () => {
    const fixture = await createFixture()
    const { managed, sessions, manifests } = fixture
    const workspace = await managed.create(randomUUID())
    const journal = await sessions.create(workspace, 'test:model')
    await managed.attachSession(workspace, journal.sessionId)
    await writeFile(join(manifests, `${randomUUID()}.json`), '{')
    assert.deepEqual(await deleteJournal(fixture, journal, undefined), { deleted: true })
    await assert.rejects(access(workspace.workingDirectory), /ENOENT/)
    assert.deepEqual(await sessions.list(), [])
  })

  it('真实文件清理失败仍保留重试入口，不伪装成已删除', async () => {
    const fixture = await createFixture()
    const { root, sessions, managed } = fixture
    const workspace = await managed.create(randomUUID())
    const journal = await sessions.create(workspace, 'test:model')
    await managed.attachSession(workspace, journal.sessionId)
    const failure = Object.assign(new Error('文件被占用'), { code: 'EBUSY' })
    const deletion = await stageSessionDeletion({
      sessionId: journal.sessionId, sessions,
      commandSessions: { removeSession: async () => {} }, scratch: new SessionScratchManager(join(root, 'scratch')),
      onBeforeFactSourceDelete: () => cleanupSessionWorkspace(journal.sessionId, workspace, {
        detachSession: async () => { throw failure }, removeSession: managed.removeSession.bind(managed),
      }, unusedWorktrees),
    })
    await assert.rejects(deletion.finish(), error => error === failure)
    assert.equal((await sessions.list())[0]?.resumable, false)
    await access(join(root, 'sessions', journal.sessionId, 'transcript.jsonl'))
    assert.deepEqual(await deleteJournal(fixture, journal, workspace), { deleted: true })
    assert.deepEqual(await sessions.list(), [])
  })
})

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'whycode-workspace-delete-'))
  roots.push(root)
  await mkdir(join(root, 'workspace'))
  const manifests = join(root, 'manifests')
  return { root, manifests, sessions: new DesktopSessionRepository(join(root, 'sessions')),
    managed: new ManagedWorkspaceManager(await realpath(join(root, 'workspace')), manifests) }
}

async function deleteJournal(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  journal: SessionJournal,
  workspace: WorkspaceBinding | undefined,
) {
  const { root, sessions, managed } = fixture
  const deletion = await stageSessionDeletion({
    sessionId: journal.sessionId, sessions,
    commandSessions: { removeSession: async () => {} }, scratch: new SessionScratchManager(join(root, 'scratch')),
    onBeforeFactSourceDelete: () => cleanupSessionWorkspace(journal.sessionId, workspace, managed, unusedWorktrees),
  })
  assert.equal(deletion.sessionExists, true)
  return deletion.finish()
}

async function assertDeleted(fixture: Awaited<ReturnType<typeof createFixture>>, journal: SessionJournal) {
  await assert.rejects(access(join(fixture.root, 'sessions', journal.sessionId)), /ENOENT/)
  await assert.rejects(access(join(fixture.root, 'sessions', '.deleting', journal.sessionId)), /ENOENT/)
}
