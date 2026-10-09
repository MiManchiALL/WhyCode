import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { GitRepository, openGitRepository } from './git-repository.ts'
import { readGitChanges, readGitFilePreview } from './git-changes.ts'
import { mutateGitRepository } from './git-actions.ts'
import { GIT_MAX_FILES, type GitComparison, type GitMutation } from '../shared/git.ts'
import { CHECKPOINT_FILE_PREVIEW_MAX_BYTES as GIT_PREVIEW_BYTES } from '@whycode/core'

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-git-test-'))
  t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const directory = join(root, 'project')
  await mkdir(directory)
  const repo = new GitRepository(directory)
  const git = (args: string[]) => repo.text(args, '测试 Git', { readOnly: false })
  await git(['init', '-b', 'main'])
  await git(['config', 'user.name', 'Git Test'])
  await git(['config', 'user.email', 'git-test@example.invalid'])
  await git(['config', 'core.autocrlf', 'false'])
  const write = (path: string, content: string | Buffer) => writeFile(join(directory, path), content)
  const commit = async (message = 'initial') => { await git(['add', '-A']); await git(['commit', '-m', message]); return repo.commit('HEAD') }
  const changes = async (query: GitComparison) => readGitChanges(repo, await repo.info(), query)
  const preview = async (query: GitComparison, path: string) => readGitFilePreview(repo, await repo.info(), query, path)
  const mutate = async (action: GitMutation['action']) => {
    const info = await repo.info()
    return mutateGitRepository(repo, { expectedHead: info.head, expectedBranch: info.branch, action })
  }
  return { root, directory, repo, git, write, commit, changes, preview, mutate }
}

test('普通仓库、非仓库与尚无提交的仓库使用同一入口', async t => {
  const f = await fixture(t)
  assert.equal(await openGitRepository(f.root), null)
  assert.equal((await openGitRepository(f.directory))?.root.replaceAll('\\', '/'), (await realpath(f.directory)).replaceAll('\\', '/'))
  const info = await f.repo.info()
  assert.equal(info.branch, 'main'); assert.equal(info.head, null)
  await f.write('first.txt', 'hello\n')
  assert.equal((await f.changes({ mode: 'branch', baseRef: null })).untracked, 1)
  await f.git(['add', 'first.txt'])
  const staged = await f.preview({ mode: 'staged' }, 'first.txt')
  assert.deepEqual(staged.before, { kind: 'missing' })
  assert.equal(staged.after.kind, 'text')
  const changes = await f.changes({ mode: 'uncommitted' })
  assert.equal(changes.added, 1)
  await f.mutate({ kind: 'commit', scope: 'staged', message: 'first' })
  const history = await f.repo.history(0)
  assert.equal(history.commits[0]?.subject, 'first')
  assert.deepEqual(history.commits[0]?.parents, [])
  assert.equal((await f.changes({ mode: 'commit', commit: history.commits[0]!.hash })).added, 1)
})

test('暂存、未暂存与全部改动读取各自版本，路径按字面匹配', async t => {
  const f = await fixture(t)
  const path = '中文 [literal] file.txt'
  await f.write(path, 'before\nunchanged\n'); await f.commit()
  await f.write(path, 'staged\nunchanged\n'); await f.git(['add', '--', path])
  await f.write(path, 'working\nunchanged\n')
  for (const [mode, before, after] of [
    ['staged', 'before', 'staged'], ['unstaged', 'staged', 'working'], ['uncommitted', 'before', 'working'],
  ] as const) {
    const preview = await f.preview({ mode }, path)
    assert.equal(preview.before.kind === 'text' && preview.before.content, `${before}\nunchanged\n`)
    assert.equal(preview.after.kind === 'text' && preview.after.content, `${after}\nunchanged\n`)
    const changes = await f.changes({ mode })
    assert.equal(changes.added, 1); assert.equal(changes.removed, 1)
  }
  await assert.rejects(f.preview({ mode: 'uncommitted' }, '../outside.txt'), /仓库内/u)
})

test('重命名、删除、二进制、大文件和未跟踪文件不伪造正文或行数', async t => {
  const f = await fixture(t)
  await f.write('old.txt', 'rename this\n'); await f.write('deleted.txt', 'delete\n'); await f.commit()
  await f.git(['mv', 'old.txt', 'new.txt']); await f.git(['rm', 'deleted.txt'])
  await f.write('binary.bin', Buffer.from([0, 255, 1]))
  await f.write('large.txt', Buffer.alloc(GIT_PREVIEW_BYTES + 1, 'a'))
  const changes = await f.changes({ mode: 'uncommitted' })
  assert.equal(changes.untracked, 2)
  assert.equal(changes.files.find(file => file.relativePath === 'new.txt')?.oldPath, 'old.txt')
  const renamed = await f.preview({ mode: 'uncommitted' }, 'new.txt')
  assert.equal(renamed.before.kind === 'text' && renamed.before.content, 'rename this\n')
  assert.equal((await f.preview({ mode: 'uncommitted' }, 'deleted.txt')).after.kind, 'missing')
  assert.deepEqual((await f.preview({ mode: 'uncommitted' }, 'binary.bin')).after, { kind: 'unavailable', reason: 'binary', size: 3 })
  assert.equal((await f.preview({ mode: 'uncommitted' }, 'large.txt')).after.kind, 'unavailable')
  assert.equal(changes.files.find(file => file.relativePath === 'large.txt')?.added, undefined)
})

test('分支基准直接比较当前工作区，查看提交不会切换 HEAD', async t => {
  const f = await fixture(t)
  await f.write('a.txt', 'base\n'); const first = await f.commit('初始提交')
  await f.git(['branch', 'base'])
  await f.write('a.txt', 'second\n'); const second = await f.commit('第二次提交')
  await f.write('a.txt', 'working\n')
  const query: GitComparison = { mode: 'branch', baseRef: 'refs/heads/base' }
  const preview = await f.preview(query, 'a.txt')
  assert.equal(preview.before.kind === 'text' && preview.before.content, 'base\n')
  assert.equal(preview.after.kind === 'text' && preview.after.content, 'working\n')
  const committed = await f.preview({ mode: 'commit', commit: second }, 'a.txt')
  assert.equal(committed.after.kind === 'text' && committed.after.content, 'second\n')
  const history = await f.repo.history(0)
  assert.deepEqual(history.commits.map(commit => commit.hash), [second, first])
  assert.equal(history.commits[0]?.author, 'Git Test')
  assert.equal(await f.repo.commit('HEAD'), second)
  assert.equal(await readFile(join(f.directory, 'a.txt'), 'utf8'), 'working\n')
})

test('创建、切换、提交与推送遵守 Git 保护且校验打开时的分支', async t => {
  const f = await fixture(t)
  await f.write('a.txt', 'base\n'); await f.commit()
  const before = await f.repo.info()
  await f.mutate({ kind: 'create', name: 'feature/ui' })
  await assert.rejects(mutateGitRepository(f.repo, { expectedHead: before.head, expectedBranch: before.branch,
    action: { kind: 'create', name: 'stale-dialog' } }), /已变化/u)
  await f.write('a.txt', 'feature\n'); await f.mutate({ kind: 'commit', message: 'feature commit', scope: 'all' })
  await f.mutate({ kind: 'switch', ref: 'refs/heads/main' })
  await f.write('a.txt', 'do not overwrite\n')
  await assert.rejects(f.mutate({ kind: 'switch', ref: 'refs/heads/feature/ui' }), /overwritten/u)
  assert.equal(await readFile(join(f.directory, 'a.txt'), 'utf8'), 'do not overwrite\n')
  await f.mutate({ kind: 'commit', message: 'main work', scope: 'all' })
  const remote = join(f.root, 'remote.git')
  await f.git(['init', '--bare', remote]); await f.git(['remote', 'add', 'origin', remote])
  await f.mutate({ kind: 'push', remote: 'origin' })
  const info = await f.repo.info()
  assert.equal(info.upstream, 'refs/remotes/origin/main')
  assert.equal(info.defaultBase, info.upstream)
  assert.equal(info.ahead, 0); assert.equal(info.behind, 0)
  assert.equal((await f.changes({ mode: 'branch', baseRef: null })).files.length, 0)
  await f.mutate({ kind: 'create', name: 'another' })
  await f.mutate({ kind: 'switch', ref: 'refs/remotes/origin/main' })
  assert.equal((await f.repo.info()).branch, 'main')
  await assert.rejects(f.mutate({ kind: 'push', remote: '--force' }), /远端/u)
  await assert.rejects(f.mutate({ kind: 'create', name: '--detach' }), /无效/u)
})

test('提交已暂存内容不包含未暂存编辑，detached Worktree 可创建分支', async t => {
  const f = await fixture(t)
  await f.write('a.txt', 'base\n'); await f.commit()
  await f.write('a.txt', 'staged\n'); await f.git(['add', 'a.txt']); await f.write('a.txt', 'unstaged\n')
  await f.mutate({ kind: 'commit', scope: 'staged', message: 'staged only' })
  assert.equal(await f.git(['show', 'HEAD:a.txt']), 'staged\n')
  assert.equal(await readFile(join(f.directory, 'a.txt'), 'utf8'), 'unstaged\n')
  const worktree = join(f.root, 'linked')
  await f.git(['worktree', 'add', '--detach', worktree, 'HEAD'])
  const repo = (await openGitRepository(worktree))!
  const info = await repo.info()
  assert.equal(info.branch, null)
  await mutateGitRepository(repo, { expectedHead: info.head, expectedBranch: null, action: { kind: 'create', name: 'linked-ui' } })
  assert.equal((await repo.info()).branch, 'linked-ui')
  await assert.rejects(f.mutate({ kind: 'switch', ref: 'refs/heads/linked-ui' }), /worktree/u)
})

test('大批未跟踪文件的清单有界并显式标记截断', async t => {
  const f = await fixture(t)
  await Promise.all(Array.from({ length: GIT_MAX_FILES + 1 }, (_, i) => f.write(`file-${i}.txt`, 'test\n')))
  const changes = await f.changes({ mode: 'uncommitted' })
  assert.equal(changes.files.length, GIT_MAX_FILES)
  assert.equal(changes.truncated, true)
})

test('工作区 CRLF 按 Git 属性和配置转换，不掩盖真正的换行符修改', async t => {
  const f = await fixture(t)
  await f.write('a.txt', 'before\nunchanged\n'); await f.commit()
  await f.write('a.txt', 'after\r\nunchanged\r\n')
  for (const [autocrlf, attributes, expected] of [
    ['true', '', 'after\nunchanged\n'],
    ['false', '', 'after\r\nunchanged\r\n'],
    ['true', '*.txt -text\n', 'after\r\nunchanged\r\n'],
    ['false', '*.txt text eol=crlf\n', 'after\nunchanged\n'],
  ]) {
    await f.git(['config', 'core.autocrlf', autocrlf!]); await f.write('.gitattributes', attributes!)
    const preview = await f.preview({ mode: 'uncommitted' }, 'a.txt')
    assert.equal(preview.after.kind === 'text' && preview.after.content, expected)
  }
  assert.equal(await readFile(join(f.directory, 'a.txt'), 'utf8'), 'after\r\nunchanged\r\n')
})

test('冲突明确报错，合并提交展示相对第一父提交的改动', async t => {
  const f = await fixture(t)
  await f.write('a.txt', 'base\n'); await f.commit()
  await f.git(['switch', '-c', 'side']); await f.write('a.txt', 'side\n'); await f.commit('side')
  await f.git(['switch', 'main']); await f.write('a.txt', 'main\n'); const firstParent = await f.commit('main')
  await assert.rejects(f.git(['merge', 'side', '--no-edit']), /CONFLICT/u)
  assert.equal((await f.repo.info()).conflicts, 1)
  const conflict = await f.changes({ mode: 'unstaged' })
  assert.equal(conflict.files.length, 1)
  assert.equal(conflict.files[0]?.status, 'U')
  await assert.rejects(f.preview({ mode: 'unstaged' }, 'a.txt'), /冲突/u)
  await assert.rejects(f.mutate({ kind: 'commit', scope: 'all', message: 'unresolved' }), /冲突/u)
  await f.write('a.txt', 'resolved\n'); const merge = await f.commit('merge')
  const history = await f.repo.history(0)
  assert.equal(history.commits[0]?.parents.length, 2)
  assert.equal(history.commits[0]?.parents[0], firstParent)
  const preview = await f.preview({ mode: 'commit', commit: merge }, 'a.txt')
  assert.equal(preview.before.kind === 'text' && preview.before.content, 'main\n')
  assert.equal(preview.after.kind === 'text' && preview.after.content, 'resolved\n')
})
