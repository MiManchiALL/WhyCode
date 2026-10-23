import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { loadMcpConfiguration, type WorkspaceIO } from '@whycode/core'
import { SshMcpProjects } from './mcp-projects.ts'
import { RemoteMcpFiles } from './mcp-files.ts'
import { sshFixture } from './ssh-test-fixture.ts'
import { cleanManagedSkills } from './skill-remote.ts'

test('远端项目编辑、启停与删除使用同一文件，索引独立于侧栏且空目录完全清理', async t => {
  const env = await sshFixture(t, 'protocol')
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const invalidated: string[] = []
  let known = [env.project]
  const service = new SshMcpProjects(env.connections, () => known, async (target, directory) => { assert.equal(target, host.target); invalidated.push(directory) })
  const draft = await service.read(host.target, env.project)
  assert.equal(draft.digest, null)
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
  await assert.rejects(service.save({ ...draft, text: '{ invalid secret' }), /合法 JSON/)
  const text = JSON.stringify({ version: 1, servers: { local: { transport: 'stdio', command: 'python3', args: ['-m', 'test'] } } })
  await service.save({ ...draft, text })
  assert.equal(await readFile(join(env.root, 'project/.whycode/mcp.json'), 'utf8'), text)
  const index = JSON.parse(await readFile(join(env.root, '.whycode/mcp-projects.json'), 'utf8'))
  assert.deepEqual(index, { version: 1, projects: [env.project] })
  await assert.rejects(service.save({ ...draft, text }), /其它位置修改/)
  const workspace = { mode: 'ssh' as const, target: host.target, label: 'fixture', workingDirectory: env.project }
  await service.mutate(workspace, { scope: 'project', name: 'local', enabled: false })
  await service.mutate(workspace, { scope: 'project', name: 'http', server: { transport: 'http', url: 'http://localhost:8888/mcp' } })
  const config = await loadMcpConfiguration({ globalConfigPath: join(env.root, 'global.json'), ...service.options(workspace) })
  assert.deepEqual(config.servers.map(server => [server.name, server.scope]), [['http', 'project']])
  known = []
  const rows = await service.list(env.id)
  assert.equal(rows.length, 1)
  assert.ok(rows[0]!.digest)
  await mkdir(join(env.root, 'project/.whycode/skills'))
  await writeFile(join(env.root, 'project/.whycode/skills/keep'), 'user skill')
  await service.remove(env.id, [{ directory: env.project, digest: rows[0]!.digest! }])
  assert.deepEqual(invalidated, [env.project])
  assert.equal(await readFile(join(env.root, 'project/.whycode/skills/keep'), 'utf8'), 'user skill')
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
  await assert.rejects(access(join(env.root, 'project/.whycode/mcp.json')), { code: 'ENOENT' })
})

test('删除失败保留索引，外部修改须重新确认，未登记的项目配置可查找并管理', async t => {
  const env = await sshFixture(t, 'protocol')
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const path = `${env.project}/.whycode/mcp.json`
  await mkdir(join(env.root, 'project/.whycode'))
  await writeFile(join(env.root, 'project/.whycode/mcp.json'), '{}')
  const files = new RemoteMcpFiles(host.io, host.home)
  const rows = await files.list([env.project])
  const selection = [{ directory: env.project, digest: rows[0]!.digest! }]
  await writeFile(join(env.root, 'project/.whycode/mcp.json'), '{"changed":true}')
  await assert.rejects(files.remove(selection, async () => {}), /配置已变化/)
  const updated = await files.list([])
  const brokenIO: WorkspaceIO = { ...host.io, fs: { ...host.io.fs, unlink: async file => { if (file === path) throw new Error('unlink failed'); await host.io.fs.unlink(file) } } }
  await assert.rejects(new RemoteMcpFiles(brokenIO, host.home).remove([{ directory: env.project, digest: updated[0]!.digest! }], async () => {}), /unlink failed/)
  assert.equal((await files.list([])).length, 1)
  const unreadable: WorkspaceIO = { ...host.io, fs: { ...host.io.fs, lstat: async file => {
    if (file === path) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    return host.io.fs.lstat(file)
  } } }
  const denied = await new RemoteMcpFiles(unreadable, host.home).list([])
  assert.match(denied[0]!.error!, /permission denied/)
  assert.equal((await files.list([])).length, 1)
  await assert.rejects(files.list([`${env.project}/../other`]), /规范化/)
  await files.remove([{ directory: env.project, digest: updated[0]!.digest! }], async () => {})
  await assert.rejects(access(join(env.root, 'project/.whycode')), { code: 'ENOENT' })
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
})

test('Skill 清理保留 MCP 索引，随后删除 MCP 清理空目录；配置路径拒绝符号链接', async t => {
  const env = await sshFixture(t, 'protocol')
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const files = new RemoteMcpFiles(host.io, host.home)
  await files.save(env.project, '{"version":1,"servers":{}}', null)
  await cleanManagedSkills(host.io, host.home, {})
  assert.equal((await files.list([])).length, 1)
  const rows = await files.list([])
  await files.remove([{ directory: env.project, digest: rows[0]!.digest! }], async () => {})
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
  await mkdir(join(env.root, 'outside'))
  await writeFile(join(env.root, 'outside/mcp.json'), 'keep')
  await symlink(join(env.root, 'outside'), join(env.root, 'project/.whycode'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(files.read(env.project), /普通目录/)
  assert.equal(await readFile(join(env.root, 'outside/mcp.json'), 'utf8'), 'keep')
})

test('同账号配置操作排队，Skill 与 MCP 不会交错删除共享目录', async t => {
  const env = await sshFixture(t, 'protocol')
  await env.connections.connect(env.id, env.fingerprint)
  const order: string[] = []
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>(resolve => { entered = resolve })
  const wait = new Promise<void>(resolve => { release = resolve })
  const first = env.connections.withConfigurationFiles(env.id, async () => { order.push('first'); entered(); await wait; order.push('done') })
  await ready
  const second = env.connections.withConfigurationFiles(env.id, async () => { order.push('second') }, undefined, true)
  await assert.rejects(env.connections.removeLocal(env.id), /配置操作/)
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'done', 'second'])
})

test('上传中断的临时文件仍有项目清理入口，索引临时文件和空父目录也能清理', async t => {
  const env = await sshFixture(t, 'protocol')
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const files = new RemoteMcpFiles(host.io, host.home)
  await files.save(env.project, '{"version":1,"servers":{}}', null)
  await host.io.fs.unlink(`${env.project}/.whycode/mcp.json`)
  const temporary = 'mcp.json.12345678-1234-1234-1234-123456789abc.tmp'
  await writeFile(join(env.root, 'project/.whycode', temporary), 'partial upload')
  await writeFile(join(env.root, '.whycode/mcp-projects.json.12345678-1234-1234-1234-123456789abc.tmp'), 'partial index')
  const rows = await files.list([])
  assert.equal(rows[0]!.incomplete, true)
  await files.remove([{ directory: env.project, digest: rows[0]!.digest! }], async () => {})
  await assert.rejects(access(join(env.root, 'project/.whycode')), { code: 'ENOENT' })
  await assert.rejects(access(join(env.root, '.whycode')), { code: 'ENOENT' })
})
