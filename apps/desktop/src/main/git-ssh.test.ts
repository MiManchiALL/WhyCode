import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sshFixture } from './ssh/ssh-test-fixture.ts'
import { GitRepository, openGitRepository } from './git-repository.ts'
import { readGitChanges, readGitFilePreview } from './git-changes.ts'
import { mutateGitRepository } from './git-actions.ts'
import { readGitSnapshot } from './git-snapshot.ts'

test('SSH 仓库通过正式远端进程读取差异、提交、切换与推送，参数保持字面含义', {
  skip: process.env.WHYCODE_SSH_INTEGRATION !== '1', timeout: 120_000,
}, async t => {
  const env = await sshFixture(t, true)
  assert.equal((await env.connections.connect(env.id, env.fingerprint)).status, 'connected')
  const host = env.connections.host(env.id)
  const io = env.connections.io(host.target)
  const missingGit = await readGitSnapshot(openGitRepository(env.project, {
    ...io, spawn: (command, cwd) => io.spawn!(`PATH=; export PATH; ${command}`, cwd),
  }), { mode: 'uncommitted' })
  assert.equal(missingGit.status, 'git-not-found')
  const repo = new GitRepository(env.project, io)
  const git = (args: string[]) => repo.text(args, '远端测试 Git', { readOnly: false })
  await git(['init', '-b', 'main'])
  assert.equal(await openGitRepository(env.remoteRoot, io), null)
  await assert.rejects(openGitRepository(`${env.remoteRoot}/missing`, io), /no such file|chdir/iu)
  await git(['config', 'user.name', 'Remote Test'])
  await git(['config', 'user.email', 'remote@example.invalid'])
  const path = "file ' $(touch unexpected).txt"
  await io.fs.writeFile(`${env.project}/${path}`, 'initial\n')
  await git(['add', '--', path]); await git(['commit', '-m', 'first'])
  await io.fs.writeFile(`${env.project}/${path}`, 'changed\n')
  const opened = await openGitRepository(env.project, io)
  assert.ok(opened)
  const info = await opened.info()
  assert.equal(info.branch, 'main')
  const changes = await readGitChanges(opened, info, { mode: 'uncommitted' })
  assert.equal(changes.files[0]?.relativePath, path)
  const preview = await readGitFilePreview(opened, info, { mode: 'uncommitted' }, path)
  assert.equal(preview.before.kind === 'text' && preview.before.content, 'initial\n')
  assert.equal(preview.after.kind === 'text' && preview.after.content, 'changed\n')
  const name = "feature/it's-safe"
  await mutateGitRepository(opened, { expectedHead: info.head, expectedBranch: info.branch, action: { kind: 'create', name } })
  await mutateGitRepository(opened, { expectedHead: info.head, expectedBranch: name,
    action: { kind: 'commit', scope: 'all', message: "literal ' $(touch unexpected) `touch unexpected`" } })
  assert.equal((await opened.history(0)).commits[0]?.subject, "literal ' $(touch unexpected) `touch unexpected`")
  await assert.rejects(io.fs.stat(`${env.project}/unexpected`), { code: 'ENOENT' })
  await git(['init', '--bare', `${env.remoteRoot}/remote.git`])
  await git(['remote', 'add', 'origin', `${env.remoteRoot}/remote.git`])
  const ready = await opened.info()
  await mutateGitRepository(opened, { expectedHead: ready.head, expectedBranch: name, action: { kind: 'push', remote: 'origin' } })
  assert.equal((await opened.info()).upstream, `refs/remotes/origin/${name}`)
  assert.equal((await readGitChanges(opened, await opened.info(), { mode: 'branch', baseRef: null })).files.length, 0)
  await mutateGitRepository(opened, { expectedHead: ready.head, expectedBranch: name, action: { kind: 'switch', ref: 'refs/heads/main' } })
  const main = await opened.info()
  await mutateGitRepository(opened, { expectedHead: main.head, expectedBranch: 'main', action: { kind: 'switch', ref: `refs/remotes/origin/${name}` } })
  assert.equal((await opened.info()).branch, name)
})
