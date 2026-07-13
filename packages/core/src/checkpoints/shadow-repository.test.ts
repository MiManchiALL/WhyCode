import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { simpleGit } from 'simple-git'
import { releaseShadowRefs, ShadowRepository } from './shadow-repository.ts'

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  ))
})

describe('Shadow Git 会话级释放', () => {
  it('同一项目多会话只释放目标 refs，保留另一会话的可达对象', async () => {
    const fixture = await createFixture()
    const firstSession = '11111111-1111-4111-8111-111111111111'
    const secondSession = '22222222-2222-4222-8222-222222222222'
    const firstCheckpoint = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const secondCheckpoint = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    await writeFile(join(fixture.project, 'state.txt'), 'first session only')
    const firstCommit = await fixture.repository.capture(
      firstSession,
      firstCheckpoint,
      'before',
    )
    await writeFile(join(fixture.project, 'state.txt'), 'second session survives')
    const secondCommit = await fixture.repository.capture(
      secondSession,
      secondCheckpoint,
      'before',
    )
    const storageDir = await onlyRepositoryDir(fixture.storage)
    const git = gitFor(storageDir)
    await Promise.all([
      access(join(storageDir, 'indexes', firstSession)),
      access(join(storageDir, 'indexes', secondSession)),
    ])
    const firstIndex = join(storageDir, 'indexes', firstSession)
    const secondIndex = join(storageDir, 'indexes', secondSession)
    await writeFile(secondIndex, 'corrupt index cache')
    await writeFile(`${secondIndex}.lock`, 'stale lock')
    const restartedCommit = await new ShadowRepository(
      fixture.project,
      fixture.storage,
    ).capture(
      secondSession,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'after-restart',
    )
    assert.equal((await git.raw(['cat-file', '-t', restartedCommit])).trim(), 'commit')
    await access(firstIndex)

    await fixture.repository.deleteCheckpointRefs(firstSession, firstCheckpoint)
    await rm(firstIndex, { force: true })
    await writeFile(`${firstIndex}.lock`, 'stale lock owned by deleted session')

    await releaseShadowRefs(fixture.storage, firstSession)

    assert.deepEqual(await whycodeRefs(git), [
      `refs/whycode/${secondSession}/${secondCheckpoint}/before`,
      `refs/whycode/${secondSession}/cccccccc-cccc-4ccc-8ccc-cccccccccccc/after-restart`,
    ])
    assert.equal((await git.raw(['ls-files'])).trim(), '')
    assert.equal((await git.raw(['cat-file', '-t', secondCommit])).trim(), 'commit')
    await assert.rejects(git.raw(['cat-file', '-t', firstCommit]))
    await assert.rejects(access(join(storageDir, 'indexes', firstSession)))
    await assert.rejects(access(join(storageDir, 'indexes', secondSession)))
    await access(storageDir)

    await writeFile(join(fixture.project, 'state.txt'), 'broken after deleting first session')
    await fixture.repository.restorePaths(secondCommit, ['state.txt'])
    assert.equal(await readFile(join(fixture.project, 'state.txt'), 'utf8'), 'second session survives')

    await writeFile(join(fixture.project, 'state.txt'), 'second session after shared GC')
    const nextCommit = await fixture.repository.capture(
      secondSession,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'after-gc',
    )
    assert.equal((await git.raw(['cat-file', '-t', nextCommit])).trim(), 'commit')
    await access(join(storageDir, 'indexes', secondSession))

    await releaseShadowRefs(fixture.storage, secondSession)
    await assert.rejects(access(storageDir))
  })

  it('删除会话不会清理该会话从未使用的其它项目仓库', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-shadow-release-roots-'))
    tempRoots.push(root)
    const storage = join(root, 'storage')
    const firstProject = join(root, 'first-project')
    const secondProject = join(root, 'second-project')
    await Promise.all([mkdir(firstProject), mkdir(secondProject)])
    const deletedSession = '99999999-9999-4999-8999-999999999999'
    const survivingSession = '10101010-1010-4010-8010-101010101010'
    await writeFile(join(firstProject, 'first.txt'), 'deleted session')
    await new ShadowRepository(firstProject, storage).capture(
      deletedSession,
      '11111111-aaaa-4aaa-8aaa-111111111111',
      'before',
    )
    await writeFile(join(secondProject, 'second.txt'), 'unrelated project survives')
    await new ShadowRepository(secondProject, storage).capture(
      survivingSession,
      '22222222-bbbb-4bbb-8bbb-222222222222',
      'before',
    )
    const rootsBefore = await readdir(join(storage, 'roots'), { withFileTypes: true })
    const unrelatedStorage = rootsBefore
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(storage, 'roots', entry.name))
      .find((candidate) => existsSync(join(candidate, 'indexes', survivingSession)))
    assert.ok(unrelatedStorage)

    await releaseShadowRefs(storage, deletedSession)

    await access(join(unrelatedStorage, 'indexes', survivingSession))
    assert.deepEqual(await whycodeRefs(gitFor(unrelatedStorage)), [
      `refs/whycode/${survivingSession}/22222222-bbbb-4bbb-8bbb-222222222222/before`,
    ])
  })

  it('删除已经没有 refs、但仍有会话 index 的孤儿仓库', async () => {
    const fixture = await createFixture()
    const owner = '33333333-3333-4333-8333-333333333333'
    const checkpoint = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    await writeFile(join(fixture.project, 'orphan.txt'), 'must disappear with repository')
    await fixture.repository.capture(owner, checkpoint, 'before')
    await fixture.repository.deleteCheckpointRefs(owner, checkpoint)
    const storageDir = await onlyRepositoryDir(fixture.storage)
    await access(join(storageDir, 'indexes', owner))

    await releaseShadowRefs(
      fixture.storage,
      owner,
    )

    await assert.rejects(access(storageDir))
  })

  it('空仓库回收后，同项目仍存活的实例会在下次 capture 时重新初始化', async () => {
    const fixture = await createFixture()
    const survivingSession = '66666666-6666-4666-8666-666666666666'
    const deletedSession = '77777777-7777-4777-8777-777777777777'
    const firstCheckpoint = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const nextCheckpoint = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    await writeFile(join(fixture.project, 'state.txt'), 'initialize shared repository')
    await fixture.repository.capture(survivingSession, firstCheckpoint, 'before')
    await fixture.repository.deleteCheckpointRefs(survivingSession, firstCheckpoint)
    const oldStorageDir = await onlyRepositoryDir(fixture.storage)

    await releaseShadowRefs(fixture.storage, deletedSession)
    await assert.rejects(access(oldStorageDir))

    await writeFile(join(fixture.project, 'state.txt'), 'capture after repository cleanup')
    const commit = await fixture.repository.capture(
      survivingSession,
      nextCheckpoint,
      'before',
    )
    const recreatedStorageDir = await onlyRepositoryDir(fixture.storage)
    assert.equal(
      (await gitFor(recreatedStorageDir).raw(['cat-file', '-t', commit])).trim(),
      'commit',
    )
  })

  it('共享仓库损坏时传播释放错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-shadow-release-broken-'))
    tempRoots.push(root)
    const brokenGitDir = join(root, 'storage', 'roots', 'broken', '.git')
    await mkdir(brokenGitDir, { recursive: true })

    await assert.rejects(
      releaseShadowRefs(
        join(root, 'storage'),
        '55555555-5555-4555-8555-555555555555',
      ),
    )
    await access(brokenGitDir)
  })

  it('在读取文件内容前拒绝超预算树和变成目录的局部路径', async () => {
    const fixture = await createFixture()
    const oversized = join(fixture.project, 'oversized.csv')
    await writeFile(oversized, '')
    await truncate(oversized, 65 * 1024 * 1024)

    await assert.rejects(
      fixture.repository.capture(
        '88888888-8888-4888-8888-888888888888',
        'ffffffff-ffff-4fff-8fff-ffffffffffff',
        'before',
      ),
      /单文件预算/,
    )

    await mkdir(join(fixture.project, 'replaced-file.txt'))
    await assert.rejects(
      fixture.repository.capture(
        '88888888-8888-4888-8888-888888888888',
        'eeeeeeee-ffff-4fff-8fff-ffffffffffff',
        'restore-safety',
        ['replaced-file.txt'],
      ),
      /路径类型已改变/,
    )
  })
})

async function createFixture(): Promise<{
  project: string
  storage: string
  repository: ShadowRepository
}> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-shadow-release-'))
  tempRoots.push(root)
  const project = join(root, 'project')
  const storage = join(root, 'storage')
  await mkdir(project)
  return {
    project,
    storage,
    repository: new ShadowRepository(project, storage),
  }
}

async function onlyRepositoryDir(storage: string): Promise<string> {
  const rootsDir = join(storage, 'roots')
  const entries = (await readdir(rootsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
  assert.equal(entries.length, 1)
  return join(rootsDir, entries[0]!.name)
}

function gitFor(storageDir: string) {
  return simpleGit({ baseDir: storageDir }).env({ GIT_DIR: join(storageDir, '.git') })
}

async function whycodeRefs(git: ReturnType<typeof simpleGit>): Promise<string[]> {
  return (await git.raw(['for-each-ref', '--format=%(refname)', 'refs/whycode/']))
    .split(/\r?\n/)
    .filter(Boolean)
    .sort()
}
