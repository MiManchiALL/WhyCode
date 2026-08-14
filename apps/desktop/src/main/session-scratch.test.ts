import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { SessionScratchManager } from './session-scratch.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })))
})

describe('会话临时工作区', () => {
  it('为每个会话建立稳定的 Main 目录', async () => {
    const manager = await createManager()
    const sessionId = randomUUID()

    const first = await manager.ensure(sessionId)
    const second = await manager.ensure(sessionId)

    assert.deepEqual(second, first)
    await access(first.mainDirectory)
  })

  it('Fork 复制完整 scratch 树且之后互不影响', async () => {
    const manager = await createManager()
    const sourceSessionId = randomUUID()
    const source = await manager.ensure(sourceSessionId)
    const sourceFile = join(source.mainDirectory, 'inspect.js')
    const consensusDirectory = join(source.rootDirectory, 'consensus', 'task-1', 'B')
    const consensusFile = join(consensusDirectory, 'result.txt')
    await writeFile(sourceFile, 'source')
    await mkdir(consensusDirectory, { recursive: true })
    await writeFile(consensusFile, 'evidence', { flag: 'wx', flush: true })

    const target = await manager.snapshot(
      sourceSessionId,
      randomUUID(),
    )
    assert.equal(
      await readFile(join(target.mainDirectory, 'inspect.js'), 'utf8'),
      'source',
    )
    assert.equal(
      await readFile(join(target.rootDirectory, 'consensus', 'task-1', 'B', 'result.txt'), 'utf8'),
      'evidence',
    )

    await writeFile(join(target.mainDirectory, 'inspect.js'), 'target')
    assert.equal(await readFile(sourceFile, 'utf8'), 'source')
  })

  it('启动清理只删除没有会话事实的目录', async () => {
    const manager = await createManager()
    const activeSessionId = randomUUID()
    const orphanSessionId = randomUUID()
    const active = await manager.ensure(activeSessionId)
    const orphan = await manager.ensure(orphanSessionId)
    await writeFile(join(active.mainDirectory, 'keep.txt'), 'keep')
    await writeFile(join(orphan.mainDirectory, 'remove.txt'), 'remove')

    const result = await manager.cleanupAbandoned(new Set([activeSessionId]))

    assert.deepEqual(result, { removed: [orphanSessionId], warnings: [] })
    await access(active.rootDirectory)
    await assert.rejects(access(orphan.rootDirectory))
  })

  it('scratch 根被替换成链接时拒绝沿链接递归删除', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-session-scratch-'))
    tempRoots.push(root)
    const scratchRoot = join(root, 'scratch')
    const outsideRoot = join(root, 'outside')
    const sessionId = randomUUID()
    const outsideSession = join(outsideRoot, sessionId, 'Main')
    const sentinel = join(outsideSession, 'keep.txt')
    await mkdir(outsideSession, { recursive: true })
    await writeFile(sentinel, 'keep')
    await symlink(
      outsideRoot,
      scratchRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const manager = new SessionScratchManager(scratchRoot)

    await assert.rejects(
      () => manager.remove(sessionId),
      /路径不是普通目录/,
    )
    assert.equal(await readFile(sentinel, 'utf8'), 'keep')
  })
})

async function createManager(): Promise<SessionScratchManager> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-session-scratch-'))
  tempRoots.push(root)
  return new SessionScratchManager(join(root, 'scratch'))
}
