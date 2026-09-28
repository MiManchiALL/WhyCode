import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { ProjectStore } from './project-store.ts'
import { pendingWorktreeWorkspace } from '../shared/workspace.ts'

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'whycode-projects-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'project')
  await mkdir(directory)
  const path = join(root, 'state', 'projects.json')
  const store = new ProjectStore(path)
  await store.initialize()
  return { root, directory, path, store }
}

it('项目登记规范化目录，并发添加同一路径只保留一个项目；改名和归属在重启后恢复', async t => {
  const { directory, path, store } = await fixture(t)
  const [first, second] = await Promise.all([store.add(directory), store.add(join(directory, '.'))])
  assert.equal(first.id, second.id)
  if (process.platform === 'win32') assert.equal((await store.add(directory.toUpperCase())).id, first.id)
  const sessionId = randomUUID()
  await Promise.all([
    store.rename(first.id, '  新项目名称  '),
    store.attachSession(sessionId, { mode: 'local', workingDirectory: directory }),
  ])
  const restarted = new ProjectStore(path)
  await restarted.initialize()
  assert.deepEqual(restarted.list(), [{ ...first, name: '新项目名称', sessionIds: [sessionId] }])
  const copy = restarted.list()
  copy[0]!.sessionIds.length = 0
  assert.deepEqual(restarted.get(first.id).sessionIds, [sessionId])
  assert.throws(() => store.rename(first.id, '\n'), /名称/)
  assert.throws(() => store.rename(first.id, 'a'.repeat(201)), /名称/)
  assert.throws(() => store.rename(first.id, 'a\nb'), /名称/)
})

it('移除项目只解除归属，保留项目文件和会话文件；重新添加不认领旧会话', async t => {
  const { root, directory, path, store } = await fixture(t)
  const project = await store.add(directory)
  const sessionId = randomUUID()
  const sessionFile = join(root, 'session.jsonl')
  const projectFile = join(directory, 'keep.txt')
  await writeFile(sessionFile, 'session history')
  await writeFile(projectFile, 'project content')
  await store.attachSession(sessionId, { mode: 'local', workingDirectory: directory })
  await store.remove(project.id)
  assert.equal(await readFile(sessionFile, 'utf8'), 'session history')
  assert.equal(await readFile(projectFile, 'utf8'), 'project content')
  const restarted = new ProjectStore(path)
  await restarted.initialize()
  assert.deepEqual(restarted.list(), [])
  const replacement = await restarted.add(directory)
  assert.notEqual(replacement.id, project.id)
  assert.deepEqual(replacement.sessionIds, [])
  await restarted.inheritSession(sessionId, randomUUID())
  assert.deepEqual(restarted.get(replacement.id).sessionIds, [])
})

it('只有明确选中的本地项目和 Worktree 源目录归组，默认目录与子目录不误归组；Fork 沿用归属', async t => {
  const { root, directory, store } = await fixture(t)
  const project = await store.add(directory)
  const ids = Array.from({ length: 7 }, () => randomUUID())
  await store.attachSession(ids[0]!, { mode: 'pending-managed', id: ids[0]!, workingDirectory: directory })
  await store.attachSession(ids[1]!, { mode: 'managed', id: ids[1]!, workingDirectory: directory, createdAt: new Date().toISOString() })
  await store.attachSession(ids[2]!, { mode: 'local', workingDirectory: join(directory, 'nested') })
  await store.attachSession(ids[3]!, pendingWorktreeWorkspace({ mode: 'worktree', selectedDirectory: directory,
    baseRef: 'main', expectedBaseCommit: 'a'.repeat(40), acknowledgeUncommittedChangesExcluded: false }))
  await store.attachSession(ids[4]!, { mode: 'worktree', id: randomUUID(), repositoryDirectory: root,
    relativeWorkingDirectory: 'project', worktreeDirectory: join(root, 'checkout'), baseRef: 'main', baseCommit: 'a'.repeat(40), createdAt: new Date().toISOString() })
  await store.inheritSession(ids[3]!, ids[5]!)
  await store.inheritSession(ids[3]!, ids[5]!)
  await store.inheritSession(ids[0]!, ids[6]!)
  assert.deepEqual(store.get(project.id).sessionIds, ids.slice(3, 6))
  await store.detachSession(ids[3]!)
  assert.deepEqual(store.get(project.id).sessionIds, ids.slice(4, 6))
})

it('保存失败不发布未持久化变更；损坏登记明确报错，不静默重置', async t => {
  const { root, directory, path, store } = await fixture(t)
  const project = await store.add(directory)
  await rm(join(root, 'state'), { recursive: true })
  await writeFile(join(root, 'state'), 'blocked')
  await assert.rejects(store.remove(project.id))
  assert.deepEqual(store.list(), [project])
  await rm(join(root, 'state'))
  await mkdir(join(root, 'state'))
  await writeFile(path, JSON.stringify({ version: 1, projects: [{ ...project, sessionIds: ['../invalid'] }] }))
  await assert.rejects(new ProjectStore(path).initialize())
  await store.rename(project.id, '可继续保存')
  const restored = new ProjectStore(path)
  await restored.initialize()
  assert.equal(restored.get(project.id).name, '可继续保存')
})

it('远端项目按服务器身份和区分大小写的目录归组，重连配置可复用登记但不改写会话绑定', async t => {
  const { path, store } = await fixture(t)
  const binding = { mode: 'ssh' as const, connectionId: randomUUID(), target: 'ssh:user@host:22#SHA256:key', label: '服务器', workingDirectory: '/project' }
  const first = await store.addRemote(binding)
  const secondHost = await store.addRemote({ ...binding, target: 'ssh:user@other:22#SHA256:key' })
  const upperCase = await store.addRemote({ ...binding, workingDirectory: '/Project' })
  assert.equal(new Set([first.id, secondHost.id, upperCase.id]).size, 3)
  const sessionId = randomUUID()
  await store.attachSession(sessionId, binding)
  await store.rename(first.id, '远端开发')
  const replacement = { ...binding, connectionId: randomUUID(), label: '新连接' }
  assert.equal((await store.addRemote(replacement)).id, first.id)
  const restarted = new ProjectStore(path)
  await restarted.initialize()
  assert.deepEqual(restarted.get(first.id), { ...first, name: '远端开发', sessionIds: [sessionId],
    remote: { connectionId: replacement.connectionId, target: binding.target, label: replacement.label } })
  assert.deepEqual(restarted.get(secondHost.id).sessionIds, [])
  assert.deepEqual(restarted.get(upperCase.id).sessionIds, [])
  assert.notEqual(binding.connectionId, replacement.connectionId)
})
