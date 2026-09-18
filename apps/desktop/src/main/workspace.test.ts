import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  DEFAULT_WORKSPACE_NAME,
  ensureDefaultWorkspace,
  ManagedWorkspaceManager,
} from './workspace.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('会话受管默认工作区', () => {
  it('每个会话使用独立子目录，删除会话会连同外置所有权记录一起清理', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    const manifests = join(root, 'manifests')
    await mkdir(workspaceRoot)
    const manager = new ManagedWorkspaceManager(await realpath(workspaceRoot), manifests)
    const firstId = '11111111-1111-4111-8111-111111111111'
    const secondId = '22222222-2222-4222-8222-222222222222'
    const firstSession = '33333333-3333-4333-8333-333333333333'
    const secondSession = '44444444-4444-4444-8444-444444444444'

    const first = await manager.create(firstId)
    const second = await manager.create(secondId)
    await manager.attachSession(first, firstSession)
    await manager.attachSession(second, secondSession)
    await writeFile(join(first.workingDirectory, 'first.txt'), 'first')
    await writeFile(join(second.workingDirectory, 'second.txt'), 'second')

    await manager.removeSession(firstSession)

    await assert.rejects(() => stat(first.workingDirectory), /ENOENT/)
    assert.equal((await stat(join(second.workingDirectory, 'second.txt'))).isFile(), true)
    assert.deepEqual(await readdir(manifests), [`${secondId}.json`])
  })

  it('启动清理只删除没有会话事实引用的受管目录', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const manager = new ManagedWorkspaceManager(
      await realpath(workspaceRoot),
      join(root, 'manifests'),
    )
    const retainedId = '11111111-1111-4111-8111-111111111111'
    const abandonedId = '22222222-2222-4222-8222-222222222222'
    const retained = await manager.create(retainedId)
    const abandoned = await manager.create(abandonedId)
    await writeFile(join(abandoned.workingDirectory, 'artifact.txt'), 'owned')

    const result = await manager.cleanupAbandoned([], new Set([retainedId]))

    assert.deepEqual(result, { removed: [abandonedId], warnings: [] })
    assert.equal((await stat(retained.workingDirectory)).isDirectory(), true)
    await assert.rejects(() => stat(abandoned.workingDirectory), /ENOENT/)
  })

  it('Fork 并发添加共享引用，删除源会话后保留目录，最后一个引用删除才清理', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    const manifests = join(root, 'manifests')
    await mkdir(workspaceRoot)
    const manager = new ManagedWorkspaceManager(await realpath(workspaceRoot), manifests)
    const binding = await manager.create('11111111-1111-4111-8111-111111111111')
    const source = '22222222-2222-4222-8222-222222222222'
    const fork = '33333333-3333-4333-8333-333333333333'
    const next = '44444444-4444-4444-8444-444444444444'
    await Promise.all([source, fork, next].map(id => manager.attachSession(binding, id)))
    const file = join(binding.workingDirectory, 'artifact.txt')
    await writeFile(file, 'shared')
    await assert.rejects(() => manager.remove(binding), /仍被会话引用/)
    await assert.rejects(() => manager.restoreDraft(binding.id), /已经属于已发送/)
    await manager.removeSession(source)
    await manager.assertUsable(binding, fork)
    await manager.assertUsable(binding, next)
    assert.equal(await readFile(file, 'utf8'), 'shared')
    // Failed Fork cleanup removes only the attached child's reference, and is idempotent.
    await manager.detachSession(binding, next)
    await manager.detachSession(binding, next)
    await manager.assertUsable(binding, fork)
    const reopened = new ManagedWorkspaceManager(manager.rootDirectory, manifests)
    await reopened.assertUsable(binding, fork)
    await reopened.detachSession(binding, fork)
    await assert.rejects(() => stat(binding.workingDirectory), /ENOENT/)
    assert.deepEqual(await readdir(manifests), [])
  })

  it('失败的未认领 Fork 不删除源目录，启动按事实源修复认领前的崩溃窗口', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    await mkdir(workspaceRoot)
    const manager = new ManagedWorkspaceManager(await realpath(workspaceRoot), join(root, 'manifests'))
    const workspace = await manager.create('11111111-1111-4111-8111-111111111111')
    const source = '22222222-2222-4222-8222-222222222222'
    const fork = '33333333-3333-4333-8333-333333333333'
    await manager.attachSession(workspace, source)
    await manager.detachSession(workspace, fork)
    await manager.assertUsable(workspace, source)
    const result = await manager.cleanupAbandoned([
      { sessionId: source, workspace }, { sessionId: fork, workspace },
    ], new Set())
    assert.deepEqual(result, { removed: [], warnings: [] })
    await manager.detachSession(workspace, source)
    await manager.assertUsable(workspace, fork)
    await manager.removeSession(fork)
    await assert.rejects(() => stat(workspace.workingDirectory), /ENOENT/)
  })

  it('启动不能丢掉损坏会话的已有引用，必须显式删除最后一个会话才清理', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, 'workspace'))
    const manager = new ManagedWorkspaceManager(await realpath(join(root, 'workspace')), join(root, 'manifests'))
    const binding = await manager.create('11111111-1111-4111-8111-111111111111')
    const source = '22222222-2222-4222-8222-222222222222'
    const fork = '33333333-3333-4333-8333-333333333333'
    await manager.attachSession(binding, source)
    await manager.attachSession(binding, fork)
    assert.deepEqual(await manager.cleanupAbandoned([
      { sessionId: source, workspace: binding }, { sessionId: fork },
    ], new Set()), { removed: [], warnings: [] })
    await manager.detachSession(binding, source)
    assert.equal((await stat(binding.workingDirectory)).isDirectory(), true)
    await manager.removeSession(fork)
    await assert.rejects(stat(binding.workingDirectory), /ENOENT/)
  })

  it('无法识别目标归属时返回保留原因，不让无关损坏记录阻塞历史删除', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    const manifests = join(root, 'manifests')
    await mkdir(workspaceRoot)
    await mkdir(manifests)
    await writeFile(join(manifests, 'broken.json'), '{')
    const manager = new ManagedWorkspaceManager(await realpath(workspaceRoot), manifests)

    const warnings = await manager.removeSession('33333333-3333-4333-8333-333333333333')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0] ?? '', /broken.json/)
    assert.equal(await readFile(join(manifests, 'broken.json'), 'utf8'), '{')
  })
})

describe('默认工作文件夹', () => {
  it('优先在 Documents 中创建用户可见的 WhyCode Workspace', async () => {
    const root = await temporaryRoot()
    const documents = join(root, 'Documents')
    const path = await ensureDefaultWorkspace(documents, join(root, 'user-data'))

    assert.equal(path, await realpath(join(documents, DEFAULT_WORKSPACE_NAME)))
    assert.equal((await stat(path)).isDirectory(), true)
  })

  it('重复初始化复用同一默认目录且不清空已有内容', async () => {
    const root = await temporaryRoot()
    const documents = join(root, 'Documents')
    const userData = join(root, 'user-data')
    const first = await ensureDefaultWorkspace(documents, userData)
    const marker = join(first, '保留文件.txt')
    await writeFile(marker, 'keep')

    const second = await ensureDefaultWorkspace(documents, userData)
    assert.equal(second, first)
    assert.equal((await stat(marker)).isFile(), true)
  })

  it('Documents 目标被普通文件占用时退回 userData 私有工作目录', async () => {
    const root = await temporaryRoot()
    const documents = join(root, 'Documents')
    const occupied = join(documents, DEFAULT_WORKSPACE_NAME)
    await mkdir(documents, { recursive: true })
    await writeFile(occupied, 'occupied')

    const path = await ensureDefaultWorkspace(documents, join(root, 'user-data'))
    assert.equal(path, await realpath(join(root, 'user-data', 'workspace')))
    assert.equal((await stat(path)).isDirectory(), true)
  })
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-workspace-'))
  roots.push(root)
  return root
}
