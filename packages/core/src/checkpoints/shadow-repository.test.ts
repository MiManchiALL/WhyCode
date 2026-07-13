import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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

    await releaseShadowRefs(fixture.storage, firstSession)

    assert.deepEqual(await whycodeRefs(git), [
      `refs/whycode/${secondSession}/${secondCheckpoint}/before`,
    ])
    assert.equal((await git.raw(['ls-files'])).trim(), '')
    assert.equal((await git.raw(['cat-file', '-t', secondCommit])).trim(), 'commit')
    await assert.rejects(git.raw(['cat-file', '-t', firstCommit]))
    await access(storageDir)

    await releaseShadowRefs(fixture.storage, secondSession)
    await assert.rejects(access(storageDir))
  })

  it('删除已经没有 refs、但 index 仍保留内容的孤儿仓库', async () => {
    const fixture = await createFixture()
    const owner = '33333333-3333-4333-8333-333333333333'
    const checkpoint = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    await writeFile(join(fixture.project, 'orphan.txt'), 'must disappear with repository')
    await fixture.repository.capture(owner, checkpoint, 'before')
    await fixture.repository.deleteCheckpointRefs(owner, checkpoint)
    const storageDir = await onlyRepositoryDir(fixture.storage)
    assert.notEqual((await gitFor(storageDir).raw(['ls-files'])).trim(), '')

    await releaseShadowRefs(
      fixture.storage,
      '44444444-4444-4444-8444-444444444444',
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
