import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { localWorkspaceIO, type WorkspaceIO } from '@whycode/core'
import { GitNotFoundError, requireGitSuccess, runGit } from './git-process.ts'
import { GitRepository, openGitRepository } from './git-repository.ts'
import { readGitSnapshot } from './git-snapshot.ts'

async function directory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-git-snapshot-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  return root
}

function shellIO(prefix = ''): WorkspaceIO {
  return { ...localWorkspaceIO, identity: 'ssh:test', spawn(command, cwd) {
    const child = spawn('sh', ['-c', `${prefix}${command}`], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    return Object.assign(child, { terminate: async () => child.kill() })
  } }
}

test('本机找不到 Git 可执行文件时返回独立状态，保留原始启动错误', async t => {
  const root = await directory(t)
  const pathKey = Object.keys(process.env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const original = process.env[pathKey]
  try {
    process.env[pathKey] = root
    await assert.rejects(runGit(root, ['--version']), error => {
      assert.ok(error instanceof GitNotFoundError)
      assert.equal((error.cause as NodeJS.ErrnoException).code, 'ENOENT')
      return true
    })
    const snapshot = await readGitSnapshot(openGitRepository(root), { mode: 'uncommitted' })
    assert.deepEqual(snapshot, { status: 'git-not-found', repository: null, changes: null, changesError: null })
  } finally {
    if (original === undefined) delete process.env[pathKey]
    else process.env[pathKey] = original
  }
})

test('远端命令在无 Git 的 PATH 下返回缺失状态，Git 自身退出 127 仍是执行错误', async t => {
  const root = await directory(t)
  const missing = await readGitSnapshot(openGitRepository(root, shellIO('PATH=; export PATH; ')), { mode: 'uncommitted' })
  assert.equal(missing.status, 'git-not-found')
  const result = await runGit(root, ['-c', 'alias.fail=!exit 127', 'fail'], { io: shellIO() })
  assert.equal(result.code, 127)
  assert.throws(() => requireGitSuccess(result, '执行 Git'), error => {
    assert.ok(error instanceof Error && !(error instanceof GitNotFoundError))
    return true
  })
})

test('目录缺失、权限、连接和超时错误不会成为缺少 Git 或非仓库', async t => {
  const root = await directory(t)
  const denied = await runGit(root, ['--version'], {
    io: shellIO("env() { printf 'Permission denied\\n' >&2; return 126; }; PATH=; export PATH; "),
  })
  assert.equal(denied.code, 126)
  assert.throws(() => requireGitSuccess(denied, '执行 Git'), /Permission denied/u)
  const missingDirectory = join(root, 'missing')
  for (const io of [localWorkspaceIO, shellIO()]) {
    await assert.rejects(readGitSnapshot(openGitRepository(missingDirectory, io), { mode: 'uncommitted' }), error => {
      assert.ok(error instanceof Error && !(error instanceof GitNotFoundError))
      return true
    })
  }
  for (const message of ['Permission denied', 'SSH connection closed', '读取 Git 仓库超时']) {
    const error = new Error(message)
    await assert.rejects(readGitSnapshot(Promise.reject(error), { mode: 'uncommitted' }), actual => actual === error)
  }
})

test('快照区分非仓库和正常仓库；比较错误保留仓库，Git 消失则清除仓库', async t => {
  const root = await directory(t)
  assert.equal((await readGitSnapshot(openGitRepository(root), { mode: 'uncommitted' })).status, 'not-repository')
  const repo = new GitRepository(root)
  requireGitSuccess(await repo.run(['init', '-b', 'main']), '创建测试仓库')
  const ready = await readGitSnapshot(Promise.resolve(repo), { mode: 'uncommitted' })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.repository?.branch, 'main')
  assert.deepEqual(ready.changes?.files, [])
  const invalidBase = await readGitSnapshot(Promise.resolve(repo), { mode: 'branch', baseRef: 'refs/heads/missing' })
  assert.equal(invalidBase.status, 'ready')
  assert.ok(invalidBase.repository)
  assert.ok(invalidBase.changesError)

  const missing = { status: 'git-not-found', repository: null, changes: null, changesError: null }
  t.mock.method(repo, 'info', async () => { throw new GitNotFoundError() })
  assert.deepEqual(await readGitSnapshot(Promise.resolve(repo), { mode: 'uncommitted' }), missing)
  t.mock.method(repo, 'info', async () => ready.repository!)
  t.mock.method(repo, 'run', async () => { throw new GitNotFoundError() })
  assert.deepEqual(await readGitSnapshot(Promise.resolve(repo), { mode: 'uncommitted' }), missing)
})
