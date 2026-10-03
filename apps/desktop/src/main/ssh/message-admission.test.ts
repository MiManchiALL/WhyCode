import assert from 'node:assert/strict'
import { once } from 'node:events'
import { join } from 'node:path'
import { it } from 'node:test'
import { localWorkspace, type WorkspaceBinding } from '@whycode/core'
import { sshMessageUnavailableReason } from '../../shared/ssh.ts'
import { SshConnections } from './connections.ts'
import { SshWorkspaces } from './workspaces.ts'
import { sshFixture } from './ssh-test-fixture.ts'

it('SSH 输入校验区分主动断开与意外掉线，且只检查状态不连接或准备文件', { timeout: 60_000 }, async t => {
  const env = await sshFixture(t, 'protocol')
  await env.store.trust(env.id, env.fingerprint)
  const connection = (await env.store.get(env.id)).connection
  const workspace: Extract<WorkspaceBinding, { mode: 'ssh' }> = {
    mode: 'ssh', label: connection.name, workingDirectory: env.project,
    target: `ssh:${connection.username}@${connection.host}:${connection.port}#${env.fingerprint}`,
  }
  const workspaces = new SshWorkspaces(env.connections)
  const assertBlocked = async (pattern: RegExp) => {
    assert.match(sshMessageUnavailableReason(env.connections.status(env.id))!, pattern)
    const commandCount = env.commands.length
    await assert.rejects(workspaces.assertMessageAllowed(workspace), pattern)
    assert.equal(env.commands.length, commandCount)
  }
  await workspaces.assertMessageAllowed(localWorkspace(env.root))
  assert.match(sshMessageUnavailableReason(undefined)!, /原 SSH 连接已删除/)
  await assertBlocked(/SSH 未连接/)

  const connecting = env.connections.connect(env.id)
  await assertBlocked(/SSH 正在连接/)
  await connecting
  assert.equal(sshMessageUnavailableReason(env.connections.status(env.id)), null)
  const readyCommands = env.commands.length
  await workspaces.assertMessageAllowed(workspace)
  assert.equal(env.commands.length, readyCommands)

  const host = env.connections.host(env.id)
  const closed = once(host.client, 'close')
  host.client.end()
  await closed
  assert.equal(env.connections.status(env.id), 'interrupted')
  assert.equal(sshMessageUnavailableReason(env.connections.status(env.id)), null)
  await workspaces.assertMessageAllowed(workspace)
  assert.equal(env.connections.status(env.id), 'interrupted')
  assert.equal(env.commands.length, readyCommands)
  await env.connections.resume(env.id)
  assert.equal(env.connections.status(env.id), 'connected')

  env.connections.disconnect(env.id)
  await assertBlocked(/SSH 未连接/)
  await env.connections.connect(env.id)
  const cleanup = env.connections.cleanup(env.id)
  await assertBlocked(/正在清理/)
  await cleanup
  await assertBlocked(/SSH 未连接/)

  const restarted = new SshWorkspaces(new SshConnections(env.store, join(env.root, 'resources')))
  await assert.rejects(restarted.assertMessageAllowed(workspace), /SSH 未连接/)
  await env.connections.removeLocal(env.id)
  await assert.rejects(workspaces.assertMessageAllowed(workspace), /连接.*删除/)
})
