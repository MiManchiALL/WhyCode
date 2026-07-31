import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { workspaceWorkingDirectory } from '@whycode/core'
import { requireGitSuccess, runGit } from './git-process.ts'
import { WorktreeManager } from './worktree-manager.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }),
  ))
})

describe('受管 Worktree 生命周期', () => {
  it('从精确提交隔离本地脏改动，复制显式 ignored 附件并跨重启交付分支', async () => {
    const fixture = await createRepository({ includeEntry: 'ignored' })
    await writeFile(join(fixture.repository, 'tracked.txt'), 'local dirty\n', 'utf8')
    await writeFile(join(fixture.repository, 'local-only.txt'), 'not committed\n', 'utf8')

    const manager = new WorktreeManager(fixture.managerRoot)
    const candidate = await manager.inspect(join(fixture.repository, 'src'))
    assert.equal(candidate.relativeWorkingDirectory, 'src')
    assert.equal(candidate.baseCommit, fixture.baseCommit)
    assert.equal(candidate.baseRef, 'main')
    assert.equal(candidate.dirty, true)
    assert.equal(candidate.changedFileCount, 2)

    const request = {
      mode: 'worktree' as const,
      selectedDirectory: join(fixture.repository, 'src'),
      expectedBaseCommit: fixture.baseCommit,
      acknowledgeUncommittedChangesExcluded: false,
    }
    await assert.rejects(
      manager.create(request, randomUUID(), 'runtime-rejected'),
      /明确确认/,
    )

    const binding = await manager.create(
      { ...request, acknowledgeUncommittedChangesExcluded: true },
      randomUUID(),
      'runtime-one',
    )
    assert.equal(binding.baseCommit, fixture.baseCommit)
    assert.equal(binding.relativeWorkingDirectory, 'src')
    assert.equal(await git(binding.worktreeDirectory, ['rev-parse', 'HEAD']), fixture.baseCommit)
    assert.equal(
      await git(binding.worktreeDirectory, ['symbolic-ref', '--quiet', '--short', 'HEAD'], true),
      '',
    )
    assert.equal(
      await readFile(join(binding.worktreeDirectory, 'tracked.txt'), 'utf8'),
      'baseline\n',
    )
    assert.equal(
      await readFile(join(binding.worktreeDirectory, 'ignored', 'secret.txt'), 'utf8'),
      'copied secret\n',
    )
    await assert.rejects(access(join(binding.worktreeDirectory, 'local-only.txt')))
    assert.equal(
      workspaceWorkingDirectory(binding),
      join(binding.worktreeDirectory, 'src'),
    )
    assert.equal((await manager.status(binding)).dirty, false)
    await assert.rejects(manager.remove(binding, true), /活动会话占用/)

    manager.release(binding, 'runtime-one')
    const sessionId = randomUUID()
    await manager.attachSession(binding, sessionId)

    const restarted = new WorktreeManager(fixture.managerRoot)
    await restarted.assertUsable(binding, sessionId, 'runtime-restored')
    const branchName = `whycode/test-${binding.id.slice(0, 8)}`
    await restarted.createBranch(binding, branchName)
    assert.equal((await restarted.status(binding)).branch, branchName)

    await writeFile(join(binding.worktreeDirectory, 'tracked.txt'), 'worktree result\n', 'utf8')
    const changed = await restarted.status(binding)
    assert.equal(changed.dirty, true)
    assert.equal(changed.entries.some((entry) => entry.path === 'tracked.txt'), true)
    assert.match(changed.diff, /worktree result/)
    assert.equal(
      await readFile(join(fixture.repository, 'tracked.txt'), 'utf8'),
      'local dirty\n',
    )

    restarted.release(binding, 'runtime-restored')
    await assert.rejects(restarted.remove(binding, false), /未提交更改/)
    await restarted.remove(binding, true)
    await assert.rejects(access(binding.worktreeDirectory))
    assert.equal(
      await git(fixture.repository, ['rev-parse', `refs/heads/${branchName}`]),
      fixture.baseCommit,
    )
  })

  it('只自动清理干净且未绑定会话的草稿，脏草稿默认保留', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const request = await worktreeRequest(manager, fixture.repository)

    const clean = await manager.create(request, randomUUID(), 'runtime-clean')
    const repositoryContainer = dirname(clean.worktreeDirectory)
    await manager.cleanupDraft(clean, 'runtime-clean')
    await assert.rejects(access(clean.worktreeDirectory))
    await assert.rejects(access(repositoryContainer))

    const dirty = await manager.create(request, randomUUID(), 'runtime-dirty')
    await writeFile(join(dirty.worktreeDirectory, 'scratch.txt'), 'keep me\n', 'utf8')
    await manager.cleanupDraft(dirty, 'runtime-dirty')
    await access(dirty.worktreeDirectory)
    assert.equal((await manager.status(dirty)).dirty, true)

    await manager.remove(dirty, true)
    await assert.rejects(access(dirty.worktreeDirectory))
    await assert.rejects(access(repositoryContainer))
  })

  it('启动时回收无会话的干净草稿，同时保留真正含改动的草稿', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const request = await worktreeRequest(manager, fixture.repository)
    const clean = await manager.create(request, randomUUID(), 'runtime-clean-crash')
    manager.release(clean, 'runtime-clean-crash')
    const dirty = await manager.create(request, randomUUID(), 'runtime-dirty-crash')
    await writeFile(join(dirty.worktreeDirectory, 'scratch.txt'), 'keep me\n', 'utf8')
    manager.release(dirty, 'runtime-dirty-crash')
    const protectedBySessionStart = await manager.create(
      request,
      randomUUID(),
      'runtime-session-start-crash',
    )
    manager.release(protectedBySessionStart, 'runtime-session-start-crash')

    const restarted = new WorktreeManager(fixture.managerRoot)
    const staleEmptyContainer = join(fixture.managerRoot, '0123456789abcdef')
    const unrelatedEmptyDirectory = join(fixture.managerRoot, 'keep-empty')
    await mkdir(staleEmptyContainer)
    await mkdir(unrelatedEmptyDirectory)
    assert.deepEqual(
      await restarted.pruneEmptyRepositoryDirectories(),
      ['0123456789abcdef'],
    )
    await assert.rejects(access(staleEmptyContainer))
    await access(unrelatedEmptyDirectory)
    const cleanup = await restarted.cleanupAbandonedDrafts(
      new Set([protectedBySessionStart.id]),
    )
    assert.deepEqual(new Set(cleanup.removed), new Set([clean.id]))
    assert.deepEqual(
      new Set(cleanup.retained),
      new Set([dirty.id, protectedBySessionStart.id]),
    )
    assert.deepEqual(cleanup.warnings, [])
    await assert.rejects(access(clean.worktreeDirectory))
    await access(dirty.worktreeDirectory)
    await access(protectedBySessionStart.worktreeDirectory)

    await restarted.remove(dirty, true)
    await restarted.remove(protectedBySessionStart, true)
    await assert.rejects(access(dirname(protectedBySessionStart.worktreeDirectory)))
  })

  it('Windows 下忽略 core.filemode=true 产生的纯执行位假改动并回收草稿', {
    skip: process.platform !== 'win32',
  }, async () => {
    const fixture = await createRepository()
    await git(fixture.repository, ['config', 'core.filemode', 'true'])
    await git(fixture.repository, ['update-index', '--chmod=+x', 'tracked.txt'])
    await git(fixture.repository, ['commit', '-m', 'executable bit'])
    assert.match(await git(fixture.repository, ['status', '--short']), /M tracked\.txt/u)

    const manager = new WorktreeManager(fixture.managerRoot)
    const candidate = await manager.inspect(fixture.repository)
    assert.equal(candidate.dirty, false)
    assert.equal(candidate.changedFileCount, 0)
    const binding = await manager.create({
      mode: 'worktree',
      selectedDirectory: fixture.repository,
      expectedBaseCommit: candidate.baseCommit!,
      acknowledgeUncommittedChangesExcluded: false,
    }, randomUUID(), 'runtime-filemode')
    assert.match(await git(binding.worktreeDirectory, ['status', '--short']), /M tracked\.txt/u)
    assert.equal((await manager.status(binding)).dirty, false)
    manager.release(binding, 'runtime-filemode')

    const restarted = new WorktreeManager(fixture.managerRoot)
    const cleanup = await restarted.cleanupAbandonedDrafts(new Set())
    assert.deepEqual(cleanup.removed, [binding.id])
    assert.deepEqual(cleanup.retained, [])
    assert.deepEqual(cleanup.warnings, [])
    await assert.rejects(access(binding.worktreeDirectory))
  })

  it('未绑定分支的 detached 提交不会被干净草稿清理', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const binding = await manager.create(
      await worktreeRequest(manager, fixture.repository),
      randomUUID(),
      'runtime-detached-commit',
    )
    await writeFile(join(binding.worktreeDirectory, 'tracked.txt'), 'committed result\n', 'utf8')
    await git(binding.worktreeDirectory, ['add', 'tracked.txt'])
    await git(binding.worktreeDirectory, ['commit', '-m', 'detached result'])
    const detachedCommit = await git(binding.worktreeDirectory, ['rev-parse', 'HEAD'])

    await manager.cleanupDraft(binding, 'runtime-detached-commit')
    await access(binding.worktreeDirectory)
    assert.equal((await manager.status(binding)).dirty, false)
    await assert.rejects(manager.remove(binding, false), /尚未绑定分支/)

    const branchName = `whycode/detached-${binding.id.slice(0, 8)}`
    await manager.createBranch(binding, branchName)
    await manager.remove(binding, false)
    assert.equal(
      await git(fixture.repository, ['rev-parse', `refs/heads/${branchName}`]),
      detachedCommit,
    )
  })

  it('崩溃发生在 session-start 与所有权关联之间时由同一会话恢复认领', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const request = await worktreeRequest(manager, fixture.repository)
    const binding = await manager.create(request, randomUUID(), 'runtime-before-crash')
    manager.release(binding, 'runtime-before-crash')

    const restarted = new WorktreeManager(fixture.managerRoot)
    const sessionId = randomUUID()
    await restarted.assertUsable(binding, sessionId, 'runtime-after-crash')
    await assert.rejects(
      restarted.attachSession(binding, randomUUID()),
      /属于其它会话/,
    )
    restarted.release(binding, 'runtime-after-crash')
    await restarted.remove(binding, true)
  })

  it('附加清单引用非 ignored 路径时回滚 Git 登记与受管目录', async () => {
    const fixture = await createRepository({ includeEntry: 'tracked.txt' })
    const manager = new WorktreeManager(fixture.managerRoot)
    const request = await worktreeRequest(manager, fixture.repository)
    const id = randomUUID()

    await assert.rejects(
      manager.create(request, id, 'runtime-invalid-include'),
      /\.worktreeinclude 只能复制已被 Git 忽略的路径/,
    )
    assert.doesNotMatch(
      await git(fixture.repository, ['worktree', 'list', '--porcelain']),
      new RegExp(id, 'u'),
    )
    await assert.rejects(access(join(fixture.managerRoot, '.registry', `${id}.json`)))

    await writeFile(
      join(fixture.repository, '.worktreeinclude'),
      'ignored/.. /outside\n',
      'utf8',
    )
    const unsafeId = randomUUID()
    await assert.rejects(
      manager.create(
        { ...request, acknowledgeUncommittedChangesExcluded: true },
        unsafeId,
        'runtime-unsafe-include',
      ),
      /\.worktreeinclude 只接受/,
    )
    assert.doesNotMatch(
      await git(fixture.repository, ['worktree', 'list', '--porcelain']),
      new RegExp(unsafeId, 'u'),
    )
  })

  it('所选目录只存在于本地未提交内容时拒绝空执行目录并完整回滚', async () => {
    const fixture = await createRepository()
    const localOnlyDirectory = join(fixture.repository, 'draft-only')
    await mkdir(localOnlyDirectory)
    await writeFile(join(localOnlyDirectory, 'draft.txt'), 'draft\n', 'utf8')
    const manager = new WorktreeManager(fixture.managerRoot)
    const candidate = await manager.inspect(localOnlyDirectory)
    const id = randomUUID()

    await assert.rejects(
      manager.create({
        mode: 'worktree',
        selectedDirectory: localOnlyDirectory,
        expectedBaseCommit: candidate.baseCommit!,
        acknowledgeUncommittedChangesExcluded: true,
      }, id, 'runtime-local-only'),
      /所选子目录不存在于 Worktree 基线/,
    )
    assert.doesNotMatch(
      await git(fixture.repository, ['worktree', 'list', '--porcelain']),
      new RegExp(id, 'u'),
    )
  })

  it('创建前重新读取 HEAD，基线已变化时不创建到错误提交', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const candidate = await manager.inspect(fixture.repository)
    await writeFile(join(fixture.repository, 'tracked.txt'), 'second commit\n', 'utf8')
    await git(fixture.repository, ['add', 'tracked.txt'])
    await git(fixture.repository, ['commit', '-m', 'second'])
    const id = randomUUID()

    await assert.rejects(
      manager.create({
        mode: 'worktree',
        selectedDirectory: fixture.repository,
        expectedBaseCommit: candidate.baseCommit!,
        acknowledgeUncommittedChangesExcluded: false,
      }, id, 'runtime-stale-base'),
      /HEAD 已变化/,
    )
    assert.doesNotMatch(
      await git(fixture.repository, ['worktree', 'list', '--porcelain']),
      new RegExp(id, 'u'),
    )
  })

  it('原仓库丢失时默认保留内容，只有显式丢弃才按所有权清理目录', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const binding = await manager.create(
      await worktreeRequest(manager, fixture.repository),
      randomUUID(),
      'runtime-missing-repository',
    )
    manager.release(binding, 'runtime-missing-repository')
    await rm(fixture.repository, { recursive: true, force: true })

    await assert.rejects(manager.remove(binding, false), /原 Git 仓库不可用/)
    await access(binding.worktreeDirectory)
    await manager.remove(binding, true)
    await assert.rejects(access(binding.worktreeDirectory))
  })

  it('所有权清单缺失时即使显式丢弃也不碰现存目录', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const binding = await manager.create(
      await worktreeRequest(manager, fixture.repository),
      randomUUID(),
      'runtime-missing-ownership',
    )
    manager.release(binding, 'runtime-missing-ownership')
    await rm(join(fixture.managerRoot, '.registry', `${binding.id}.json`))

    await assert.rejects(manager.remove(binding, true), /所有权记录已经缺失/)
    await access(binding.worktreeDirectory)
  })

  it('受管路径被替换成目录联接或符号链接时拒绝递归删除', async () => {
    const fixture = await createRepository()
    const manager = new WorktreeManager(fixture.managerRoot)
    const binding = await manager.create(
      await worktreeRequest(manager, fixture.repository),
      randomUUID(),
      'runtime-replaced-path',
    )
    manager.release(binding, 'runtime-replaced-path')
    await rm(binding.worktreeDirectory, { recursive: true, force: true })
    const outside = join(fixture.repository, 'do-not-delete')
    await mkdir(outside)
    await writeFile(join(outside, 'sentinel.txt'), 'keep\n', 'utf8')
    await symlink(
      outside,
      binding.worktreeDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await assert.rejects(
      manager.remove(binding, true),
      /不是普通目录|符号链接|目录联接/,
    )
    assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'keep\n')
  })

  it('明确区分非 Git 文件夹和没有首个提交的仓库', async () => {
    const root = await createTempRoot()
    const manager = new WorktreeManager(join(root, 'managed'))
    const plain = join(root, 'plain')
    await mkdir(plain)
    assert.match(
      (await manager.inspect(plain)).worktreeUnavailableReason!,
      /不在 Git 仓库/,
    )

    const emptyRepository = join(root, 'empty-repository')
    await mkdir(emptyRepository)
    await git(emptyRepository, ['init', '-b', 'main'])
    assert.match(
      (await manager.inspect(emptyRepository)).worktreeUnavailableReason!,
      /还没有可用提交/,
    )
  })
})

interface RepositoryFixture {
  repository: string
  managerRoot: string
  baseCommit: string
}

async function createRepository(
  options: { includeEntry?: string } = {},
): Promise<RepositoryFixture> {
  const root = await createTempRoot()
  const repository = join(root, 'repository')
  const managerRoot = join(root, 'managed')
  await mkdir(repository)
  await git(repository, ['init', '-b', 'main'])
  await git(repository, ['config', 'user.name', 'WhyCode Test'])
  await git(repository, ['config', 'user.email', 'whycode@example.invalid'])
  await git(repository, ['config', 'core.autocrlf', 'false'])
  await mkdir(join(repository, 'src'))
  await writeFile(join(repository, 'tracked.txt'), 'baseline\n', 'utf8')
  await writeFile(join(repository, 'src', 'index.ts'), 'export const value = 1\n', 'utf8')
  await writeFile(join(repository, '.gitignore'), 'ignored/\n', 'utf8')
  if (options.includeEntry) {
    await writeFile(
      join(repository, '.worktreeinclude'),
      `${options.includeEntry}\n`,
      'utf8',
    )
  }
  await mkdir(join(repository, 'ignored'))
  await writeFile(join(repository, 'ignored', 'secret.txt'), 'copied secret\n', 'utf8')
  await git(repository, ['add', '--all'])
  await git(repository, ['commit', '-m', 'baseline'])
  return {
    repository,
    managerRoot,
    baseCommit: await git(repository, ['rev-parse', 'HEAD']),
  }
}

async function worktreeRequest(
  manager: WorktreeManager,
  repository: string,
) {
  const candidate = await manager.inspect(repository)
  return {
    mode: 'worktree' as const,
    selectedDirectory: repository,
    expectedBaseCommit: candidate.baseCommit!,
    acknowledgeUncommittedChangesExcluded: false,
  }
}

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-worktree-'))
  tempRoots.push(root)
  return root
}

async function git(
  workingDirectory: string,
  args: readonly string[],
  allowFailure = false,
): Promise<string> {
  const result = await runGit(workingDirectory, args, {
    outputLimit: 4 * 1024 * 1024,
  })
  if (allowFailure && result.code !== 0) return ''
  return requireGitSuccess(result, `Git ${args.join(' ')}`).trim()
}
