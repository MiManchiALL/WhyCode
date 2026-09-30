import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'node:test'
import { localWorkspace } from '@whycode/core'
import { ManagedWorkspaceManager } from './workspace.ts'
import { WorktreeManager } from './worktree-manager.ts'
import { WorkspaceLifecycle, type WorkspaceReference } from './workspace-lifecycle.ts'
import { WorkspaceMutations } from './workspace-retention.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('慢目录清理只串行同一工作区，其它工作区可立即提交，失败也不堵塞后续重试', { timeout: 10_000 }, async () => {
  const mutations = new WorkspaceMutations()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let nextStarted = false
  const slow = mutations.run('slow', () => wait)
  const next = mutations.run('slow', async () => { nextStarted = true })
  await mutations.run('other', async () => { assert.equal(nextStarted, false) })
  release()
  await Promise.all([slow, next])
  assert.equal(nextStarted, true)
  await assert.rejects(mutations.run('slow', async () => { throw new Error('busy') }), /busy/)
  assert.equal(await mutations.run('slow', async () => 'retried'), 'retried')
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'whycode-retained-'))
  roots.push(root)
  await mkdir(join(root, 'projects'))
  const managed = new ManagedWorkspaceManager(await realpath(join(root, 'projects')), join(root, 'manifests'))
  const worktrees = new WorktreeManager(join(root, 'worktrees'))
  const references: WorkspaceReference[] = []
  const lifecycle = new WorkspaceLifecycle(managed, worktrees, async () => [...references])
  const binding = await managed.create(randomUUID())
  const sessionId = randomUUID()
  await managed.attachSession(binding, sessionId)
  return { root, managed, worktrees, references, lifecycle, binding, sessionId }
}

for (const nonempty of [false, true]) it(`并发删除共享工作区的会话，最后一个引用${nonempty ? '保留文件' : '清理空目录'}`, { timeout: 10_000 }, async t => {
  const f = await fixture()
  const fork = randomUUID()
  await f.managed.attachSession(f.binding, fork)
  if (nonempty) await writeFile(join(f.binding.workingDirectory, 'keep.txt'), 'project data')
  let signalStarted!: () => void, unblock!: () => void
  const started = new Promise<void>(resolve => { signalStarted = resolve })
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  const detach = f.managed.detachSession.bind(f.managed)
  t.mock.method(f.managed, 'detachSession', (async (binding, sessionId, options) => {
    if (sessionId === f.sessionId) { signalStarted(); await blocked }
    return detach(binding, sessionId, options)
  }) satisfies ManagedWorkspaceManager['detachSession'])
  const first = f.lifecycle.release(f.sessionId, f.binding, 'first', false)
  await started
  const second = f.lifecycle.release(fork, f.binding, 'last', false)
  const completed = Promise.all([first, second])
  unblock()
  await completed
  if (nonempty) {
    assert.equal(await readFile(join(f.binding.workingDirectory, 'keep.txt'), 'utf8'), 'project data')
    const records = (await f.lifecycle.list()).workspaces
    assert.equal(records.length, 1)
    assert.equal(records[0]?.name, 'last')
  } else await assert.rejects(access(f.binding.workingDirectory), { code: 'ENOENT' })
})

for (const empty of [true, false]) it(`本地项目${empty ? '为空' : '非空'}也不提供清理选项，伪造勾选不会删除目录`, async () => {
  const f = await fixture()
  const directory = join(f.root, 'local')
  await mkdir(directory)
  if (!empty) await writeFile(join(directory, 'user.txt'), 'keep')
  const workspace = localWorkspace(directory)
  assert.equal((await f.lifecycle.preview(f.sessionId, workspace)).disposition, 'local')
  await f.lifecycle.release(f.sessionId, workspace, 'local', true)
  await access(directory)
  assert.deepEqual((await f.lifecycle.list()).workspaces, [])
})

it('远端会话删除预览明确区分服务器目录，释放会话不接触项目文件', async () => {
  const f = await fixture()
  const workspace = { mode: 'ssh' as const, target: 'ssh:user@host:22#SHA256:key', label: '服务器', workingDirectory: '/project' }
  assert.deepEqual(await f.lifecycle.preview(f.sessionId, workspace), { directory: '/project', disposition: 'remote', warning: null })
  await f.lifecycle.release(f.sessionId, workspace, 'remote', true)
})

it('默认保留非空工作目录，记录最后会话名称，重启清理不会删除', async () => {
  const f = await fixture()
  const file = join(f.binding.workingDirectory, 'project.html')
  await writeFile(file, 'deliverable')
  assert.equal((await f.lifecycle.preview(f.sessionId, f.binding)).disposition, 'optional')
  await f.lifecycle.release(f.sessionId, f.binding, '我的网页', false)
  const restarted = new ManagedWorkspaceManager(f.managed.rootDirectory, join(f.root, 'manifests'))
  await restarted.cleanupAbandoned([], new Set())
  const list = await new WorkspaceLifecycle(restarted, f.worktrees, async () => []).list()
  assert.equal(list.workspaces[0]?.name, '我的网页')
  assert.equal(list.workspaces[0]?.directory, f.binding.workingDirectory)
  assert.equal(await readFile(file, 'utf8'), 'deliverable')
  await assert.rejects(restarted.restoreDraft(f.binding.id), /保留工作区/)
})

it('受管空草稿目录重新选为 Local 项目后，旧草稿释放和启动回收都保留目录', async () => {
  const f = await fixture()
  const draft = await f.managed.create(randomUUID())
  f.references.push({ sessionId: null, directory: draft.workingDirectory })
  await f.managed.remove(draft, await f.lifecycle.isReferenced(draft.workingDirectory))
  await f.managed.cleanupAbandoned([], new Set())
  await access(draft.workingDirectory)
  assert.deepEqual((await f.lifecycle.list()).workspaces, [])
})

it('只有真正空目录自动清理，隐藏文件也算内容', async () => {
  const f = await fixture()
  assert.equal((await f.lifecycle.preview(f.sessionId, f.binding)).disposition, 'empty')
  await f.lifecycle.release(f.sessionId, f.binding, 'empty', false)
  await assert.rejects(access(f.binding.workingDirectory), /ENOENT/)
  assert.deepEqual(await readdir(join(f.root, 'manifests')), [])
  const other = await f.managed.create(randomUUID())
  const id = randomUUID()
  await f.managed.attachSession(other, id)
  await writeFile(join(other.workingDirectory, '.keep'), '')
  assert.equal((await f.lifecycle.preview(id, other)).disposition, 'optional')
  await f.lifecycle.release(id, other, 'hidden', false)
  await access(join(other.workingDirectory, '.keep'))
})

it('预览为空后新增文件，不会被自动空目录清理递归删除', async () => {
  const f = await fixture()
  assert.equal((await f.lifecycle.preview(f.sessionId, f.binding)).disposition, 'empty')
  await writeFile(join(f.binding.workingDirectory, 'new.txt'), 'new')
  await f.lifecycle.release(f.sessionId, f.binding, 'race', false)
  assert.equal((await f.lifecycle.list()).workspaces.length, 1)
  await access(join(f.binding.workingDirectory, 'new.txt'))
})

it('共享工作区不提供删除选项，过时请求也不能清空其它会话的文件', async () => {
  const f = await fixture()
  const fork = randomUUID()
  await f.managed.attachSession(f.binding, fork)
  const file = join(f.binding.workingDirectory, 'shared.txt')
  await writeFile(file, 'shared')
  assert.equal((await f.lifecycle.preview(f.sessionId, f.binding)).disposition, 'shared')
  assert.match(await f.lifecycle.release(f.sessionId, f.binding, 'source', true) ?? '', /全部文件/)
  assert.deepEqual((await f.lifecycle.list()).workspaces, [])
  assert.equal(await readFile(file, 'utf8'), 'shared')
  await f.lifecycle.release(fork, f.binding, '最后的会话', false)
  assert.equal((await f.lifecycle.list()).workspaces[0]?.name, '最后的会话')
})

for (const sessionId of [null, randomUUID()]) it(`${sessionId ? '本地会话' : '未发送草稿'}使用受管目录时，同样保留完整目录`, async () => {
  const f = await fixture()
  f.references.push({ sessionId, directory: f.binding.workingDirectory })
  assert.equal((await f.lifecycle.preview(f.sessionId, f.binding)).disposition, 'shared')
  await f.lifecycle.release(f.sessionId, f.binding, 'shared locally', true)
  await access(f.binding.workingDirectory)
  assert.deepEqual((await f.lifecycle.list()).workspaces, [])
  f.references.length = 0
  assert.equal((await f.lifecycle.list()).workspaces.length, 1)
})

it('列表仅显示无关联工作区，重命名只修改名称，不改变路径、时间和排序', async () => {
  const f = await fixture()
  await writeFile(join(f.binding.workingDirectory, 'keep'), '')
  await f.lifecycle.release(f.sessionId, f.binding, 'first', false)
  const other = await f.managed.create(randomUUID())
  const id = randomUUID()
  await f.managed.attachSession(other, id)
  await writeFile(join(other.workingDirectory, 'keep'), '')
  await f.lifecycle.release(id, other, 'second', false)
  const before = (await f.lifecycle.list()).workspaces
  assert.equal(before[0]?.id, other.id)
  await f.lifecycle.renameRetained(before[1]!, '重命名网页')
  const after = (await f.lifecycle.list()).workspaces
  assert.deepEqual(after.map(item => [item.id, item.directory, item.retainedAt]), before.map(item => [item.id, item.directory, item.retainedAt]))
  assert.equal(after[1]?.name, '重命名网页')
  f.references.push({ sessionId: randomUUID(), directory: other.workingDirectory })
  assert.equal((await f.lifecycle.list()).workspaces.length, 1)
  await assert.rejects(f.lifecycle.deleteRetained(before[0]!), /已不在保留列表/)
  await access(other.workingDirectory)
})

it('Local 重新使用保留工作区后删除会话，空目录仍保留并重新记录保留时间', async () => {
  const f = await fixture()
  const file = join(f.binding.workingDirectory, 'keep')
  await writeFile(file, '')
  await f.lifecycle.release(f.sessionId, f.binding, 'original', false)
  const before = (await f.lifecycle.list()).workspaces[0]!
  await rm(file)
  await f.lifecycle.release(randomUUID(), localWorkspace(f.binding.workingDirectory), 'local', false)
  const after = (await f.lifecycle.list()).workspaces[0]!
  assert.equal(after.name, before.name)
  assert.ok(after.retainedAt >= before.retainedAt)
  await access(f.binding.workingDirectory)
})

it('列表清理失败保留记录可重试；成功清理不残留项目空目录或清单', async t => {
  const f = await fixture()
  await writeFile(join(f.binding.workingDirectory, 'keep'), '')
  await f.lifecycle.release(f.sessionId, f.binding, 'cleanup', false)
  const target = (await f.lifecycle.list()).workspaces[0]!
  const failure = t.mock.method(f.managed, 'deleteRetained', async () => { throw new Error('EBUSY') })
  await assert.rejects(f.lifecycle.deleteRetained(target), /EBUSY/)
  assert.equal((await f.lifecycle.list()).workspaces.length, 1)
  failure.mock.restore()
  await f.lifecycle.deleteRetained(target)
  await assert.rejects(access(target.directory), /ENOENT/)
  assert.deepEqual(await readdir(join(f.root, 'manifests')), [])
  assert.deepEqual((await f.lifecycle.list()).workspaces, [])
})

it('目录外部删除后可清理残余记录，不能借清单路径越界删除用户目录', async () => {
  const f = await fixture()
  await writeFile(join(f.binding.workingDirectory, 'keep'), '')
  await f.lifecycle.release(f.sessionId, f.binding, 'missing', false)
  const target = (await f.lifecycle.list()).workspaces[0]!
  await rm(target.directory, { recursive: true })
  assert.equal((await f.lifecycle.previewRetained(target)).disposition, 'missing')
  await f.lifecycle.deleteRetained(target)
  const other = await f.managed.create(randomUUID())
  const recordPath = join(f.root, 'manifests', `${other.id}.json`)
  const record = JSON.parse(await readFile(recordPath, 'utf8'))
  record.workingDirectory = f.root
  await writeFile(recordPath, JSON.stringify(record))
  assert.equal((await f.lifecycle.preview(randomUUID(), other)).disposition, 'unverified')
  assert.equal((await f.lifecycle.list()).warnings.length, 1)
  await access(f.root)
})

it('目录被替换为链接时拒绝递归清理，保留外部内容', async () => {
  const f = await fixture()
  const outside = join(f.root, 'user-project')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'safe')
  await rm(f.binding.workingDirectory, { recursive: true })
  await symlink(outside, f.binding.workingDirectory, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal((await f.lifecycle.preview(f.sessionId, f.binding)).disposition, 'unverified')
  assert.match(await f.lifecycle.release(f.sessionId, f.binding, 'replaced', true) ?? '', /已保留/)
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'safe')
})

it('清理期间只阻止重新选择同一路径，失败后释放保护', async t => {
  const f = await fixture()
  let release!: () => void
  const wait = new Promise<void>(resolve => { release = resolve })
  let notifyEntered!: () => void
  const entered = new Promise<void>(resolve => { notifyEntered = resolve })
  t.mock.method(f.managed, 'detachSession', async () => { notifyEntered(); await wait })
  const cleaning = f.lifecycle.release(f.sessionId, f.binding, 'busy', true)
  await entered
  assert.throws(() => f.lifecycle.assertAvailable(f.binding.workingDirectory), /正在清理/)
  assert.doesNotThrow(() => f.lifecycle.assertAvailable(join(f.root, 'elsewhere')))
  release()
  await cleaning
  assert.doesNotThrow(() => f.lifecycle.assertAvailable(f.binding.workingDirectory))
})
