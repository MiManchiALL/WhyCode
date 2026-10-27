import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs, { access, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { localWorkspace } from '@whycode/core'
import { DesktopSessionRepository } from './session-repository.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { NewSessionStateStore } from './new-session-state.ts'
import { SessionRuntimeRegistry } from './session-runtime-registry.ts'
import { ManagedWorkspaceManager } from './workspace.ts'
import { WorktreeManager } from './worktree-manager.ts'
import { restoreSubmittedWorkspace } from './runtime-workspace.ts'
import { projectSessionListItems } from './session-list.ts'
import type { RuntimeWorkspace } from '../shared/workspace.ts'

it('列表读取关闭文件后才更新准备记录；其它会话不受阻塞，后续读取看到新工作区', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-preparation-read-write-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessions = new DesktopSessionRepository(root)
  const sessionId = randomUUID()
  const otherId = randomUUID()
  const initial = localWorkspace('C:\\initial')
  const updated = localWorkspace('C:\\updated')
  for (const id of [sessionId, otherId]) {
    await sessions.preparations.register({ sessionId: id, workspace: initial,
      modelId: 'test:model', reasoningEffort: 'default', lastUserText: '首条消息' })
  }
  const target = join(root, sessionId, 'preparation.json')
  let opened!: () => void
  let release!: () => void
  const reading = new Promise<void>(resolve => { opened = resolve })
  const continueReading = new Promise<void>(resolve => { release = resolve })
  const originalRead = fs.readFile
  let targetReads = 0
  const mockedRead = t.mock.method(fs, 'readFile', async (
    path: Parameters<typeof fs.readFile>[0], options?: Parameters<typeof fs.readFile>[1],
  ) => {
    if (path !== target || ++targetReads !== 1) return originalRead(path, options)
    const handle = await open(target, 'r')
    try {
      opened()
      await continueReading
      return await handle.readFile(options)
    } finally {
      await handle.close()
    }
  })
  syncBuiltinESMExports()
  t.after(() => { mockedRead.mock.restore(); syncBuiltinESMExports() })

  const listing = sessions.list()
  await reading
  const update = sessions.preparations.updateWorkspace(sessionId, updated)
  const afterUpdate = sessions.preparations.read(sessionId)
  const pending = Promise.all([listing, update, afterUpdate])
  // 若断言失败仍先关闭被控制的真实句柄，再等待所有读写退出。
  void pending.catch(() => {})
  try {
    await sessions.preparations.updateWorkspace(otherId, updated)
    assert.deepEqual((await sessions.preparations.read(otherId))?.workspace, updated)
    assert.equal(targetReads, 1, '同一记录的读改写必须等待先前读取结束')
  } finally {
    release()
    await pending
  }
  const [summaries, , record] = await pending
  assert.deepEqual(summaries.find(item => item.sessionId === sessionId)?.workspace, initial)
  assert.deepEqual(record?.workspace, updated)
  assert.deepEqual(await readdir(join(root, sessionId)), ['preparation.json'])
})

it('Windows 原子替换失败保留原记录、释放队列，解除文件占用后可直接重试', {
  skip: process.platform !== 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-preparation-locked-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessions = new DesktopSessionRepository(root)
  const sessionId = randomUUID()
  const initial = localWorkspace('C:\\initial')
  const updated = localWorkspace('C:\\updated')
  await sessions.preparations.register({ sessionId, workspace: initial,
    modelId: 'test:model', reasoningEffort: 'default', lastUserText: '首条消息' })
  const target = join(root, sessionId, 'preparation.json')
  const original = await readFile(target, 'utf8')
  const handle = await open(target, 'r')
  try {
    await assert.rejects(sessions.preparations.updateWorkspace(sessionId, updated), { code: 'EPERM' })
    assert.equal(await readFile(target, 'utf8'), original)
    assert.deepEqual(await readdir(join(root, sessionId)), ['preparation.json'])
  } finally {
    await handle.close()
  }
  await sessions.preparations.updateWorkspace(sessionId, updated)
  assert.deepEqual((await sessions.preparations.read(sessionId))?.workspace, updated)
  await sessions.preparations.finish(sessionId)
  assert.equal(await sessions.preparations.read(sessionId), null)
  assert.deepEqual(await readdir(join(root, sessionId)), [])
})

it('工作区创建未完成时就可从历史找到同一个运行时，另一个新草稿独立存在', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-register-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessions = new DesktopSessionRepository(join(root, 'sessions'))
  const draft = new NewSessionStateStore(join(root, 'new-session.json'))
  const runtime = new DesktopSessionRuntime({ workspace: pendingWorkspace(), modelId: 'test:model', emit: () => {} })
  const registry = new SessionRuntimeRegistry({ idleUnloadMs: -1 })
  registry.select(runtime)
  const reservation = registry.reserveWorkStart(runtime)!
  await draft.set({ runtimeId: runtime.runtimeId, workspace: runtime.workspace })
  await sessions.preparations.register({ sessionId: runtime.runtimeId, workspace: runtime.workspace,
    modelId: 'test:model', reasoningEffort: 'default', lastUserText: '创建网页' })
  runtime.registerSession()
  await draft.consume(runtime.runtimeId)
  const next = new DesktopSessionRuntime({ workspace: { mode: 'none' }, modelId: 'test:model', emit: () => {} })
  registry.select(next)
  await draft.set({ runtimeId: next.runtimeId, workspace: next.workspace })
  const items = projectSessionListItems(await sessions.list(), registry.all(), null, [], () => false)
  assert.equal(items.length, 1)
  assert.equal(items[0]?.title, '创建网页')
  assert.equal(items[0]?.running, true)
  assert.equal(registry.findBySessionId(items[0]!.sessionId), runtime)
  assert.equal(runtime.journal, null)
  const binding = localWorkspace(root)
  await sessions.preparations.updateWorkspace(runtime.sessionId!, binding)
  await draft.updateWorkspace(runtime.runtimeId, binding)
  await draft.consume(runtime.runtimeId)
  assert.equal(draft.value?.runtimeId, next.runtimeId)
  const journal = await sessions.create(binding, 'test:model', 'default', undefined, runtime.sessionId!)
  runtime.journal = journal
  await sessions.preparations.finish(journal.sessionId)
  const completed = await sessions.list()
  assert.equal(completed.length, 1)
  assert.equal(completed[0]?.sessionId, items[0]?.sessionId)
  assert.equal('preparing' in completed[0]!, false)
  reservation.release()
  await registry.closeAll()
})

it('创建失败的登记跨重启保留，删除标记不能被准备记录重新激活', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-preparation-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionId = randomUUID()
  const sessions = new DesktopSessionRepository(root)
  await sessions.preparations.register({ sessionId, workspace: pendingWorkspace(),
    modelId: 'test:model', reasoningEffort: 'high', lastUserText: '保持这条创建记录' })
  const restarted = new DesktopSessionRepository(root)
  assert.equal((await restarted.list())[0]?.title, '保持这条创建记录')
  assert.equal((await restarted.preparations.read(sessionId))?.reasoningEffort, 'high')
  await assert.rejects(restarted.preparations.register({ sessionId, workspace: { mode: 'none' },
    modelId: 'other:model', reasoningEffort: 'default', lastUserText: '重复登记' }), /EEXIST/)
  await restarted.markDeleting(sessionId)
  assert.equal((await restarted.list())[0]?.resumable, false)
  assert.equal(await restarted.preparations.read(sessionId), null)
  await restarted.delete(sessionId)
  assert.deepEqual(await restarted.list(), [])
  await assert.rejects(access(join(root, sessionId)), /ENOENT/)
})

it('Journal 建立后未清掉的准备记录不能覆盖正式工作区、开启第二次创建或掩盖损坏', async t => {
  const root = await mkdtemp(join(tmpdir(), 'whycode-preparation-journal-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionId = randomUUID()
  const sessions = new DesktopSessionRepository(root)
  await sessions.preparations.register({ sessionId, workspace: pendingWorkspace(),
    modelId: 'test:model', reasoningEffort: 'default', lastUserText: '首条消息' })
  await sessions.create(localWorkspace(root), 'test:model', 'default', undefined, sessionId)
  const restarted = new DesktopSessionRepository(root)
  assert.equal(await restarted.preparations.read(sessionId), null)
  assert.equal((await restarted.list())[0]?.workspace?.mode, 'local')
  assert.equal((await restarted.prepareResume(sessionId)).sessionId, sessionId)
  await writeFile(join(root, sessionId, 'transcript.jsonl'), '{broken')
  const [unavailable] = await new DesktopSessionRepository(root).list()
  assert.equal(unavailable?.resumable, false)
  assert.equal(unavailable?.status, 'unavailable')
})

it('目录物化后的中断仍归已登记会话，恢复过程不重新创建或丢弃用户文件', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whycode-preparation-workspace-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionId = randomUUID()
  const sessions = new DesktopSessionRepository(join(root, 'sessions'))
  const managed = new ManagedWorkspaceManager(join(root, 'work'), join(root, 'manifests'))
  const worktrees = new WorktreeManager(join(root, 'worktrees'))
  await mkdir(join(root, 'work'))
  const workspace: RuntimeWorkspace = { mode: 'pending-managed', id: sessionId,
    workingDirectory: managed.plannedDirectory(sessionId) }
  await sessions.preparations.register({ sessionId, workspace,
    modelId: 'test:model', reasoningEffort: 'default', lastUserText: '创建项目' })
  const binding = await managed.create(sessionId)
  await writeFile(join(binding.workingDirectory, 'keep.txt'), '已经创建的内容')
  const persist = (value: RuntimeWorkspace) => sessions.preparations.updateWorkspace(sessionId, value)
  const recovered = await restoreSubmittedWorkspace(sessionId, workspace, worktrees, managed, persist)
  assert.deepEqual(recovered, binding)
  assert.deepEqual((await managed.inspect(binding)).sessionIds, [sessionId])
  const record = (await sessions.preparations.read(sessionId))!
  assert.deepEqual(await restoreSubmittedWorkspace(sessionId, record.workspace, worktrees, managed, persist), binding)
  assert.equal(await readFile(join(binding.workingDirectory, 'keep.txt'), 'utf8'), '已经创建的内容')
  await assert.rejects(restoreSubmittedWorkspace(sessionId, binding, worktrees, managed, async () => {
    throw new Error('无法保存准备状态')
  }), /无法保存/)
})

function pendingWorkspace(): RuntimeWorkspace {
  return { mode: 'pending-worktree', selectedDirectory: 'C:\\project', baseRef: 'main',
    expectedBaseCommit: 'abc', acknowledgeUncommittedChangesExcluded: false }
}
