import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { it, type TestContext } from 'node:test'
import type { WorkspaceBinding } from '@whycode/core'
import { DesktopSessionRepository } from '../session-repository.ts'
import { SessionScratchManager } from '../session-scratch.ts'
import { stageSessionDeletion } from '../session-deletion.ts'
import { sshFixture } from './ssh-test-fixture.ts'
import { SshWorkspaces } from './workspaces.ts'
import { SshConnections, SshCredentialsRequiredError } from './connections.ts'
import { SshConnectionStore } from './store.ts'
import { ProjectStore } from '../project-store.ts'

async function fixture(t: TestContext) {
  const env = await sshFixture(t)
  await env.store.trust(env.id, env.fingerprint)
  const connection = (await env.store.get(env.id)).connection
  const workspace: Extract<WorkspaceBinding, { mode: 'ssh' }> = {
    mode: 'ssh', connectionId: env.id, label: connection.name, workingDirectory: env.project,
    target: `ssh:${connection.username}@${connection.host}:${connection.port}#${env.fingerprint}`,
  }
  return { ...env, workspace, workspaces: new SshWorkspaces(env.connections) }
}

it('删除 SSH 会话清理自己的远端与本地临时文件，保留项目、其它会话和组件；不启动组件', async t => {
  const env = await fixture(t)
  const sessions = new DesktopSessionRepository(join(env.root, 'sessions'))
  const scratch = new SessionScratchManager(join(env.root, 'scratch'))
  const journal = await sessions.create(env.workspace, 'test:model')
  const other = await sessions.create(env.workspace, 'test:model')
  const remoteScratch = join(env.root, '.cache/whycode-scratch', journal.sessionId)
  await mkdir(join(remoteScratch, 'Main'), { recursive: true })
  await writeFile(join(remoteScratch, 'Main/tmp.txt'), 'temporary')
  const keep = [join(env.root, 'project/keep.txt'), join(env.root, '.cache/whycode-scratch', other.sessionId, 'Main/keep.txt'), join(env.root, '.cache/whycode-remote/keep')]
  for (const file of keep) { await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'keep') }
  const local = await scratch.ensure(journal.sessionId)
  await writeFile(join(local.mainDirectory, 'tmp.txt'), 'local')
  const deletion = await stageSessionDeletion({ sessionId: journal.sessionId, sessions, scratch,
    commandSessions: { removeSession: async () => {} },
    onBeforeFactSourceDelete: () => env.workspaces.removeScratch(journal.sessionId, env.workspace),
  })
  assert.deepEqual(await deletion.finish(), { deleted: true })
  await assert.rejects(access(remoteScratch), { code: 'ENOENT' })
  await assert.rejects(access(local.rootDirectory), { code: 'ENOENT' })
  await assert.rejects(access(join(env.root, 'sessions', journal.sessionId)), { code: 'ENOENT' })
  await access(join(env.root, 'sessions', other.sessionId, 'transcript.jsonl'))
  for (const file of keep) assert.equal(await readFile(file, 'utf8'), 'keep')
  await env.workspaces.removeScratch(journal.sessionId, env.workspace)
  assert.equal(env.commands.length, 0)
  assert.equal(env.connections.isConnected(env.id), false)
})

it('SSH 清理失败保留会话事实供删除重试；连接已删除则明确提醒保留远端文件', async t => {
  const env = await fixture(t)
  const sessions = new DesktopSessionRepository(join(env.root, 'sessions'))
  const journal = await sessions.create(env.workspace, 'test:model')
  const scratch = new SessionScratchManager(join(env.root, 'scratch'))
  const current = await env.store.get(env.id)
  await env.store.save({ ...current.connection, secret: 'wrong' })
  const options = { sessionId: journal.sessionId, sessions, scratch,
    commandSessions: { removeSession: async () => {} },
    onBeforeFactSourceDelete: () => env.workspaces.removeScratch(journal.sessionId, env.workspace),
  }
  await assert.rejects((await stageSessionDeletion(options)).finish(), SshCredentialsRequiredError)
  await access(join(env.root, 'sessions', journal.sessionId, 'transcript.jsonl'))
  assert.equal((await sessions.list())[0]?.resumable, false)
  assert.match((await sessions.list())[0]?.unavailableReason ?? '', /删除未完成.*重试删除/)
  await env.store.save({ ...current.connection, secret: current.secret })
  assert.deepEqual(await (await stageSessionDeletion(options)).finish(), { deleted: true })

  const remaining = await sessions.create(env.workspace, 'test:model')
  const remoteFile = join(env.root, '.cache/whycode-scratch', remaining.sessionId, 'Main/tmp.txt')
  await mkdir(join(remoteFile, '..'), { recursive: true }); await writeFile(remoteFile, 'keep')
  await env.connections.remove(env.id)
  const deletion = await stageSessionDeletion({ ...options, sessionId: remaining.sessionId,
    onBeforeFactSourceDelete: () => env.workspaces.removeScratch(remaining.sessionId, env.workspace),
  })
  const result = await deletion.finish()
  assert.equal(result.deleted, true)
  assert.match(result.warning!, /连接已删除.*临时文件已保留/)
  assert.equal(await readFile(remoteFile, 'utf8'), 'keep')
})

it('远端临时清理拒绝越界 ID、错误服务器身份和重定向的父目录', async t => {
  const env = await fixture(t)
  const id = randomUUID()
  const parent = join(env.root, '.cache/whycode-scratch')
  const outside = join(env.root, 'project', id)
  await mkdir(outside); await writeFile(join(outside, 'keep.txt'), 'keep')
  await mkdir(join(env.root, '.cache'))
  await symlink(join(env.root, 'project'), parent, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(env.workspaces.removeScratch('../project', env.workspace), /无效会话 ID/)
  await assert.rejects(env.workspaces.removeScratch(id, { ...env.workspace, target: 'another-server' }), /服务器.*不同/)
  await assert.rejects(env.workspaces.removeScratch(id, env.workspace), /符号链接/)
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep')
})

it('远端临时目录中的链接只删除链接，不遍历其指向的项目', async t => {
  const env = await fixture(t)
  const id = randomUUID()
  const root = join(env.root, '.cache/whycode-scratch', id)
  await mkdir(root, { recursive: true })
  await writeFile(join(env.root, 'project/keep.txt'), 'keep')
  await symlink(join(env.root, 'project'), join(root, 'project-link'), process.platform === 'win32' ? 'junction' : 'dir')
  await env.workspaces.removeScratch(id, env.workspace)
  assert.equal(await readFile(join(env.root, 'project/keep.txt'), 'utf8'), 'keep')
  await assert.rejects(access(root), { code: 'ENOENT' })
})

it('删除连接在组件清理成功后移除配置；失败可重试，保留项目登记与临时目录', async t => {
  const env = await fixture(t)
  const projects = new ProjectStore(join(env.root, 'projects.json'))
  await projects.initialize()
  const project = await projects.addRemote(env.workspace)
  const directory = join(env.root, '.cache/whycode-remote')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, '.owner'), 'WhyCode remote process host v1\n')
  await writeFile(join(directory, 'host-' + 'a'.repeat(64)), 'damaged component')
  await writeFile(join(directory, 'unknown.txt'), 'keep')
  const scratch = join(env.root, '.cache/whycode-scratch', randomUUID())
  await mkdir(scratch, { recursive: true }); await writeFile(join(scratch, 'keep.txt'), 'keep')
  await assert.rejects(env.connections.remove(env.id), /未知文件/)
  assert.equal((await env.store.get(env.id)).connection.id, env.id)
  assert.equal(await readFile(join(directory, '.owner'), 'utf8'), 'WhyCode remote process host v1\n')
  await env.connections.withFiles(env.id, fs => fs.unlink(`${env.remoteRoot}/.cache/whycode-remote/unknown.txt`))
  await env.connections.cleanup(env.id)
  await assert.rejects(access(directory), { code: 'ENOENT' })
  assert.equal((await env.store.list()).length, 1)
  await env.connections.remove(env.id)
  assert.deepEqual(await env.store.list(), [])
  assert.deepEqual(projects.get(project.id), project)
  assert.equal(await readFile(join(scratch, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(env.commands.length, 0)

  const replacement = await env.store.save({ name: 'same server', host: '127.0.0.1', username: 'fixture', port: 22, authentication: 'password', rememberSecret: false })
  await assert.rejects(env.workspaces.select(project.remote!.connectionId, project.directory), /连接不存在或已删除/)
  assert.notEqual(replacement.id, project.remote!.connectionId)
  await env.connections.remove(replacement.id)
  assert.deepEqual(await env.store.list(), [])
})

it('重启丢失临时密码后连接、清理和删除都要求补充凭据；补充后可清理删除且不强制记住', async t => {
  const env = await fixture(t)
  const current = await env.store.get(env.id)
  const store = new SshConnectionStore(join(env.root, 'connections.json'), {
    isAvailable: () => true, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(),
  })
  const connections = new SshConnections(store, resolve('resources/remote'))
  t.after(() => connections.close())
  const component = join(env.root, '.cache/whycode-remote')
  await mkdir(component, { recursive: true })
  await writeFile(join(component, '.owner'), 'WhyCode remote process host v1\n')
  assert.equal((await store.list())[0]?.hasSecret, false)
  for (const action of ['connect', 'cleanup', 'remove'] as const) {
    await assert.rejects(connections[action](env.id), SshCredentialsRequiredError)
    assert.equal((await store.list()).length, 1)
    await access(join(component, '.owner'))
  }
  assert.equal(env.clients.size, 0)
  await store.save({ ...current.connection, secret: current.secret, rememberSecret: false })
  assert.equal((await store.list())[0]?.hasSecret, true)
  assert.equal(JSON.parse(await readFile(join(env.root, 'connections.json'), 'utf8'))[0].encryptedSecret, undefined)
  await connections.remove(env.id)
  await assert.rejects(access(component), { code: 'ENOENT' })
  assert.deepEqual(await store.list(), [])
  assert.equal(env.commands.length, 0)
})

it('加密私钥缺少口令时给出凭据请求，保存口令后可直接清理；错误口令仍可重试', async t => {
  const env = await fixture(t)
  const connection = (await env.store.get(env.id)).connection
  await env.store.save({ ...connection, authentication: 'key', privateKeyPath: env.keyPath, secret: '', rememberSecret: false })
  await assert.rejects(env.connections.cleanup(env.id), SshCredentialsRequiredError)
  await env.store.save({ ...connection, authentication: 'key', privateKeyPath: env.keyPath, secret: 'wrong', rememberSecret: false })
  await assert.rejects(env.connections.cleanup(env.id), SshCredentialsRequiredError)
  await env.store.save({ ...connection, authentication: 'key', privateKeyPath: env.keyPath, secret: env.keyPassword, rememberSecret: false })
  await env.connections.remove(env.id)
  assert.deepEqual(await env.store.list(), [])
})
