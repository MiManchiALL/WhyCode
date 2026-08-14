import assert from 'node:assert/strict'
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
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

    const result = await manager.cleanupAbandoned(new Set([retainedId]))

    assert.deepEqual(result, { removed: [abandonedId], warnings: [] })
    assert.equal((await stat(retained.workingDirectory)).isDirectory(), true)
    await assert.rejects(() => stat(abandoned.workingDirectory), /ENOENT/)
  })

  it('Fork 为目标会话复制独立快照，后续修改和删除互不影响', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    const manifests = join(root, 'manifests')
    await mkdir(workspaceRoot)
    const manager = new ManagedWorkspaceManager(
      await realpath(workspaceRoot),
      manifests,
    )
    const source = await manager.create('11111111-1111-4111-8111-111111111111')
    const sourceSession = '22222222-2222-4222-8222-222222222222'
    const forkSession = '33333333-3333-4333-8333-333333333333'
    await manager.attachSession(source, sourceSession)
    await mkdir(join(source.workingDirectory, 'nested'))
    await writeFile(join(source.workingDirectory, 'nested', 'artifact.txt'), 'source')
    await assert.rejects(
      () => manager.attachSession(source, forkSession),
      /已经绑定到其它会话/,
    )

    const forked = await manager.snapshot(
      source,
      sourceSession,
      '44444444-4444-4444-8444-444444444444',
    )
    await manager.attachSession(forked, forkSession)

    assert.notEqual(forked.workingDirectory, source.workingDirectory)
    assert.equal(
      await readFile(join(forked.workingDirectory, 'nested', 'artifact.txt'), 'utf8'),
      'source',
    )
    await writeFile(join(forked.workingDirectory, 'nested', 'artifact.txt'), 'fork')
    assert.equal(
      await readFile(join(source.workingDirectory, 'nested', 'artifact.txt'), 'utf8'),
      'source',
    )

    await manager.removeSession(sourceSession)
    await assert.rejects(() => stat(source.workingDirectory), /ENOENT/)
    assert.equal(
      await readFile(join(forked.workingDirectory, 'nested', 'artifact.txt'), 'utf8'),
      'fork',
    )
    assert.deepEqual(await readdir(manifests), [`${forked.id}.json`])
  })

  it('快照遇到链接时整体失败并清理未绑定目标', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    const manifests = join(root, 'manifests')
    const outside = join(root, 'outside')
    await mkdir(workspaceRoot)
    await mkdir(outside)
    const manager = new ManagedWorkspaceManager(await realpath(workspaceRoot), manifests)
    const source = await manager.create('11111111-1111-4111-8111-111111111111')
    const sourceSession = '22222222-2222-4222-8222-222222222222'
    const targetId = '33333333-3333-4333-8333-333333333333'
    await manager.attachSession(source, sourceSession)
    await symlink(
      outside,
      join(source.workingDirectory, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await assert.rejects(
      () => manager.snapshot(source, sourceSession, targetId),
      /不支持符号链接或目录联接/,
    )

    await assert.rejects(() => stat(manager.plannedDirectory(targetId)), /ENOENT/)
    assert.deepEqual(await readdir(manifests), [`${source.id}.json`])
  })

  it('找不到目标绑定且所有权记录损坏时中止删除，不静默遗留目录', async () => {
    const root = await temporaryRoot()
    const workspaceRoot = join(root, 'workspace')
    const manifests = join(root, 'manifests')
    await mkdir(workspaceRoot)
    await mkdir(manifests)
    await writeFile(join(manifests, 'broken.json'), '{')
    const manager = new ManagedWorkspaceManager(await realpath(workspaceRoot), manifests)

    await assert.rejects(
      () => manager.removeSession('33333333-3333-4333-8333-333333333333'),
      /所有权记录损坏，未完成删除/,
    )
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
