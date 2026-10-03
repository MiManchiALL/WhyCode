import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { it, type TestContext } from 'node:test'
import { sshFixture } from './ssh-test-fixture.ts'
import { SshWorkspaces } from './workspaces.ts'
import { RemoteProcessHost } from './process.ts'
import { deferred } from '../subagent-test-fixture.ts'

async function fixture(t: TestContext) {
  const env = await sshFixture(t, process.env.WHYCODE_SSH_INTEGRATION === '1' ? true : 'protocol')
  const original = await env.store.get(env.id)
  const second = await env.store.save({ ...original.connection, id: undefined, name: '第二个入口', port: await env.addEndpoint(), secret: original.secret })
  await env.connections.connect(env.id, env.fingerprint)
  await env.connections.connect(second.id, env.fingerprint)
  return { ...env, second: second.id }
}

for (const action of ['cleanup', 'remove'] as const) it(`${action} 同步停止跨端口的共享组件连接，保留项目与临时目录`, { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  const first = env.connections.host(env.id)
  const second = env.connections.host(env.second)
  assert.equal(first.component.identity, second.component.identity)
  const workspace = { mode: 'ssh' as const, target: first.target, label: '第一项', workingDirectory: env.project }
  await writeFile(join(env.root, 'project', 'keep.txt'), 'project')
  const scratch = join(env.root, '.cache/whycode-scratch/session')
  await mkdir(scratch, { recursive: true }); await writeFile(join(scratch, 'keep.txt'), 'scratch')
  const events: string[] = []
  env.connections.on('changed', () => events.push(env.connections.status(env.id)))
  await env.connections[action](env.second)
  for (const id of [env.id, env.second]) {
    assert.equal(env.connections.status(id), 'disconnected')
    await assert.rejects(env.connections.resume(id), /请先点击/)
  }
  assert.ok(events.includes('releasing'))
  assert.equal(env.connections.isTargetConnected(first.target), false)
  await assert.rejects(new SshWorkspaces(env.connections).connect(workspace), /请先点击/)
  await assert.rejects(first.processes.request({ method: 'ping' }), /已断开/)
  await assert.rejects(access(join(env.root, '.cache/whycode-remote')), { code: 'ENOENT' })
  assert.equal(await readFile(join(env.root, 'project/keep.txt'), 'utf8'), 'project')
  assert.equal(await readFile(join(scratch, 'keep.txt'), 'utf8'), 'scratch')
  assert.equal((await env.store.list()).length, action === 'remove' ? 1 : 2)
  await env.connections.connect(env.id)
  assert.notEqual(env.connections.host(env.id).component.identity, first.component.identity)
  assert.equal(await env.connections.host(env.id).io.fs.readFile(`${env.project}/keep.txt`, 'utf8'), 'project')
})

it('相同 IP、用户名与目录文字的独立环境不会被连带断开', { timeout: 60_000 }, async t => {
  const first = await fixture(t)
  const other = await sshFixture(t, 'protocol')
  const config = await other.store.get(other.id)
  const separate = await first.store.save({ ...config.connection, id: undefined, name: '独立环境', secret: config.secret })
  await first.connections.connect(separate.id, other.fingerprint)
  const untouched = first.connections.host(separate.id)
  assert.notEqual(untouched.component.identity, first.connections.host(first.id).component.identity)
  if (process.env.WHYCODE_SSH_INTEGRATION !== '1') assert.equal(untouched.component.directory, first.connections.host(first.id).component.directory)
  await first.connections.cleanup(first.second)
  assert.equal(first.connections.status(separate.id), 'connected')
  await untouched.processes.request({ method: 'ping' })
  await access(join(other.root, '.cache/whycode-remote/.identity'))
})

it('断开的入口用临时 SFTP 清理，也会关闭正在使用共享组件的另一入口', { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  env.connections.disconnect(env.second)
  await env.connections.cleanup(env.second)
  assert.equal(env.connections.status(env.id), 'disconnected')
  await assert.rejects(env.connections.resume(env.id), /请先点击/)
  await assert.rejects(access(join(env.root, '.cache/whycode-remote')), { code: 'ENOENT' })
})

it('清理撤销同组件意外掉线入口的自动恢复资格', { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  const host = env.connections.host(env.id)
  const closed = once(host.client, 'close')
  host.client.end(); await closed
  assert.equal(env.connections.status(env.id), 'interrupted')
  await env.connections.cleanup(env.second)
  await assert.rejects(env.connections.resume(env.id), /请先点击/)
})

it('共享组件清理失败后保留配置，所有相关入口仍须由用户重连', { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  await writeFile(join(env.root, '.cache/whycode-remote/keep.txt'), 'unknown')
  await assert.rejects(env.connections.remove(env.second), /未知文件/)
  assert.equal((await env.store.list()).length, 2)
  for (const id of [env.id, env.second]) await assert.rejects(env.connections.resume(id), /请先点击/)
  assert.equal(await readFile(join(env.root, '.cache/whycode-remote/keep.txt'), 'utf8'), 'unknown')
})

it('编辑为重复入口失败时，原连接和凭据保持可用', { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  const before = await env.store.get(env.second)
  const first = await env.store.get(env.id)
  await assert.rejects(env.connections.save({ ...before.connection, port: first.connection.port, secret: 'changed' }), /已存在/)
  assert.equal(env.connections.status(env.second), 'connected')
  assert.deepEqual(await env.store.get(env.second), before)
  await env.connections.host(env.second).processes.request({ method: 'ping' })
})

it('清理取消共享目录中尚未完成的连接，迟到的握手不能重新变成已连接', { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  env.connections.disconnect(env.second)
  const entered = deferred<void>()
  const gate = deferred<void>()
  const original = RemoteProcessHost.prototype.ready
  t.mock.method(RemoteProcessHost.prototype, 'ready', async function(this: RemoteProcessHost) {
    await original.call(this); entered.resolve(); await gate.promise
  })
  const connecting = env.connections.connect(env.second)
  const cancelled = assert.rejects(connecting, /清理.*取消/)
  await entered.promise
  const cleaning = env.connections.cleanup(env.id)
  assert.equal(env.connections.status(env.second), 'releasing')
  await assert.rejects(env.connections.connect(env.second), /正在清理/)
  gate.resolve()
  await cancelled
  await cleaning
  assert.equal(env.connections.status(env.second), 'disconnected')
  await assert.rejects(env.connections.resume(env.second), /请先点击/)
  await assert.rejects(access(join(env.root, '.cache/whycode-remote')), { code: 'ENOENT' })
})

it('清理期间拒绝共享目录的新入口和重复清理，结束后允许明确连接', { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  const original = await env.store.get(env.id)
  const third = await env.store.save({ ...original.connection, id: undefined, port: await env.addEndpoint(), secret: original.secret })
  const files = env.connections.host(env.id).io.fs
  const unlink = files.unlink.bind(files)
  const entered = deferred<void>()
  const gate = deferred<void>()
  t.mock.method(files, 'unlink', async (path: string) => {
    entered.resolve(); await gate.promise; await unlink(path)
  })
  const cleaning = env.connections.cleanup(env.id)
  await entered.promise
  const commands = env.commands.length
  await assert.rejects(env.connections.connect(third.id, env.fingerprint), /组件正在清理/)
  await assert.rejects(env.connections.remove(env.second), /正在清理/)
  await assert.rejects(env.connections.save({ ...original.connection, name: '正在编辑' }), /正在处理/)
  assert.equal(env.commands.length, commands, '清理期间不能启动或安装组件')
  gate.resolve(); await cleaning
  await env.connections.connect(third.id)
  assert.equal(env.connections.status(third.id), 'connected')
  await delay(20)
  assert.equal(env.connections.status(env.id), 'disconnected')
})

it('清理移除归属标记后，新入口不能替换尚未删除的组件身份', { timeout: 60_000 }, async t => {
  const env = await fixture(t)
  const original = await env.store.get(env.id)
  const third = await env.store.save({ ...original.connection, id: undefined, port: await env.addEndpoint(), secret: original.secret })
  const files = env.connections.host(env.id).io.fs
  const unlink = files.unlink.bind(files)
  const entered = deferred<void>()
  const gate = deferred<void>()
  t.mock.method(files, 'unlink', async (path: string) => {
    await unlink(path)
    if (path.endsWith('/.owner')) { entered.resolve(); await gate.promise }
  })
  const cleaning = env.connections.cleanup(env.id)
  await entered.promise
  const commands = env.commands.length
  try {
    await assert.rejects(env.connections.connect(third.id, env.fingerprint), /远端缓存目录已被占用/)
    assert.equal(env.commands.length, commands)
    assert.equal(env.connections.status(third.id), 'disconnected')
  } finally { gate.resolve(); await cleaning }
  await assert.rejects(access(join(env.root, '.cache/whycode-remote')), { code: 'ENOENT' })
})
