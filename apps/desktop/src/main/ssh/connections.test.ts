import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'node:test'
import { AgentSession, SessionStore, CheckpointManager, CommandSessionManager, BUILTIN_TOOLS, type ToolContext, type CoreEvent } from '@whycode/core'
import { WorkspaceFiles } from '../workspace-files.ts'
import { sshFixture } from './ssh-test-fixture.ts'
import { SshConnectionStore } from './store.ts'
import { SshCredentialsRequiredError } from './connections.ts'
import { SshWorkspaces, sshScratchPaths } from './workspaces.ts'
import { DesktopSessionRuntime } from '../desktop-session-runtime.ts'
import { languageModel, modelEntry, toolStream, finalStream } from '../subagent-test-fixture.ts'

const tool = (name: string) => BUILTIN_TOOLS.find(item => item.name === name)!

it('未知主机先返回指纹，认证失败和取消不部署组件，密码不进入公开配置', async t => {
  const env = await sshFixture(t)
  const changes: string[] = []
  env.connections.on('changed', () => changes.push(env.connections.status(env.id)))
  assert.equal(env.connections.status(env.id), 'disconnected')
  assert.deepEqual(await env.connections.connect(env.id), { status: 'trust-required', fingerprint: env.fingerprint, host: `127.0.0.1:${(await env.store.get(env.id)).connection.port}` })
  assert.deepEqual(changes.splice(0), ['connecting', 'disconnected'])
  assert.equal(env.commands.length, 0)
  await assert.rejects(env.connections.connect(env.id, 'SHA256:wrong'), /指纹/)
  await assert.rejects(env.connections.connect(env.id, env.fingerprint, 'wrong'), SshCredentialsRequiredError)
  assert.deepEqual(changes.splice(0), ['connecting', 'disconnected', 'connecting', 'disconnected'])
  const publicData = JSON.stringify(await env.store.list())
  assert.ok(!publicData.includes((await env.store.get(env.id)).secret!))
  assert.equal((await env.store.list())[0]?.fingerprint, undefined)
  const connecting = env.connections.connect(env.id, env.fingerprint)
  assert.equal(env.connections.status(env.id), 'connecting')
  assert.equal(env.connections.connect(env.id, env.fingerprint), connecting)
  env.connections.disconnect(env.id)
  assert.equal(env.connections.status(env.id), 'disconnected')
  await assert.rejects(connecting, /取消/)
  assert.deepEqual(changes, ['connecting', 'disconnected'])
  assert.equal(env.connections.isConnected(env.id), false)
  await assert.rejects(env.connections.resume(env.id), /请先点击/)
  assert.equal(env.commands.length, 0)
})

it('损坏或不能解密的配置不被覆盖，临时密码不持久化，修改服务器会清除旧指纹', async t => {
  const env = await sshFixture(t)
  const file = join(env.root, 'connections.json')
  const current = (await env.store.get(env.id)).connection
  assert.ok(!(await readFile(file, 'utf8')).includes((await env.store.get(env.id)).secret!))
  await env.store.trust(env.id, env.fingerprint)
  await env.store.save({ ...current, host: 'localhost', secret: '', rememberSecret: false })
  assert.equal((await env.store.list())[0]?.fingerprint, undefined)
  await env.store.save({ ...current, secret: 'fixture-secret', rememberSecret: true })
  const bytes = await readFile(file, 'utf8')
  assert.ok(!bytes.includes('fixture-secret'))
  const locked = new SshConnectionStore(file, { isAvailable: () => true, encrypt: () => '', decrypt: () => { throw new Error('locked') } })
  await assert.rejects(locked.save({ ...current, secret: '', rememberSecret: true }), /无法解密/)
  assert.equal(await readFile(file, 'utf8'), bytes)
  await writeFile(file, '{broken')
  await assert.rejects(env.store.save({ ...current, name: 'new' }), /无法读取/)
  assert.equal(await readFile(file, 'utf8'), '{broken')
})

it('真实 SSH/SFTP 与 Linux 组件完成文件、检查点、输出、后台停止、PTY 和组件清理', {
  skip: process.env.WHYCODE_SSH_INTEGRATION !== '1', timeout: 120_000,
}, async t => {
  const env = await sshFixture(t, true)
  await assert.rejects(env.connections.resume(env.id), /请先点击/)
  assert.equal(env.commands.length, 0)
  assert.equal((await env.connections.connect(env.id, env.fingerprint)).status, 'connected')
  const host = env.connections.host(env.id)
  const io = env.connections.io(host.target)
  const ctx: ToolContext = { workspaceIO: io, projectDir: env.project, additionalDirs: [], abortSignal: new AbortController().signal }
  assert.equal((await tool('WriteFile').execute({ path: '目录/说明.txt', content: 'hello\n世界\n' }, ctx)).isError, false)
  assert.equal(await readFile(join(env.root, 'project/目录/说明.txt'), 'utf8'), 'hello\n世界\n')
  const read = await tool('ReadFile').execute({ path: '目录/说明.txt' }, ctx)
  assert.match(read.data, /世界/)
  const checkpoints = new CheckpointManager({ sessionId: randomUUID(), sessionDir: join(env.root, 'journal'), workspaceIO: io })
  const file = `${env.project}/目录/说明.txt`
  const prepared = await checkpoints.prepare('edit', 'turn', { kind: 'exact-files', paths: [file] })
  assert.ok(prepared, checkpoints.disabled ?? 'checkpoint unavailable')
  assert.equal((await tool('EditFile').execute({ edits: [{ path: file, oldText: 'hello', newText: 'changed' }] }, ctx)).isError, false)
  const checkpoint = await checkpoints.finalize(prepared)
  assert.ok(checkpoint)
  assert.equal((await checkpoints.restore('edit', 'files')).ok, true)
  assert.equal(await io.fs.readFile(file, 'utf8'), 'hello\n世界\n')
  const files = new WorkspaceFiles()
  const view = await files.open(1, { runtimeId: 'remote', kind: 'file', path: file }, env.project, () => {}, io)
  assert.ok(view.kind === 'file' && view.remote && view.url)
  assert.equal(await (await files.response(new Request(view.url))).text(), 'hello\n世界\n')
  assert.throws(() => files.pathFor(1, view.id), /远端/)
  files.closeOwner(1)

  const command = host.processes.spawn("printf '中文'; printf 'error' >&2", env.project)
  let output = ''
  command.stdout.setEncoding('utf8'); command.stdout.on('data', chunk => { output += chunk })
  assert.deepEqual(await once(command, 'close'), [0])
  assert.ok(output.includes('中文') && output.includes('error'))
  const noninteractive = await tool('RunCommand').execute({ command: "read value || printf 'stdin closed'", timeoutMs: 2_000 }, ctx)
  assert.equal(noninteractive.isError, false)
  assert.equal(noninteractive.data, 'stdin closed')
  const manager = new CommandSessionManager(join(env.root, 'tasks'))
  t.after(() => manager.shutdown())
  const background = await manager.start({ sessionId: 'session', command: 'sleep 60 & wait', cwd: env.project, workspaceIO: io })
  assert.equal(background.status, 'running')
  assert.equal((await manager.stop('session', background.id)).status, 'stopped')
  assert.ok((await manager.backgroundTasks('session')).tasks.every(task => task.status !== 'running'))

  const terminal = host.processes.spawn('read value; stty size; printf "%s" "$value"', env.project, { cols: 80, rows: 24 })
  let terminalOutput = ''
  terminal.stdout.setEncoding('utf8'); terminal.stdout.on('data', chunk => { terminalOutput += chunk })
  await once(terminal, 'spawn')
  await terminal.resize(100, 30)
  const done = once(terminal, 'close')
  terminal.stdin.write('终端输入\n')
  assert.deepEqual(await done, [0])
  assert.match(terminalOutput, /30 100/)
  assert.match(terminalOutput, /终端输入/)

  const paused = host.processes.spawn('yes buffered-output', env.project, { cols: 80, rows: 24 })
  await once(paused, 'spawn')
  await delay(150)
  const concurrent = host.processes.spawn('printf responsive', env.project)
  concurrent.stdout.resume()
  assert.deepEqual(await once(concurrent, 'close'), [0])
  assert.ok(paused.stdout.writableLength < 256 * 1024)
  assert.equal(await paused.terminate(), true)
  assert.equal(env.connections.isConnected(env.id), true)

  await mkdir(join(env.root, 'project/.git'))
  await io.fs.writeFile(`${env.project}/AGENTS.md`, 'Remote fixture instructions')
  const journal = await new SessionStore(join(env.root, 'sessions')).create({
    workspace: { mode: 'ssh', target: host.target, label: 'fixture', workingDirectory: env.project }, modelId: 'test:subagent',
  })
  const workspace = journal.metadataSnapshot.workspace
  const runtime = new DesktopSessionRuntime({ workspace, modelId: null, emit: () => {} })
  runtime.journal = journal
  const workspaces = new SshWorkspaces(env.connections)
  const remote = await workspaces.prepare(runtime)
  assert.ok(remote)
  await io.fs.writeFile(`${remote.scratch.mainDirectory}/keep.txt`, 'session scratch')
  const forkId = randomUUID()
  const forkScratch = sshScratchPaths(host.home, forkId)
  await workspaces.snapshot(workspace, journal.sessionId, forkId)
  assert.equal(await io.fs.readFile(`${forkScratch.mainDirectory}/keep.txt`, 'utf8'), 'session scratch')
  await io.fs.writeFile(`${forkScratch.mainDirectory}/keep.txt`, 'fork scratch')
  await assert.rejects(workspaces.snapshot(workspace, journal.sessionId, forkId))
  assert.equal(await io.fs.readFile(`${forkScratch.mainDirectory}/keep.txt`, 'utf8'), 'fork scratch')
  assert.equal(await io.fs.readFile(`${remote.scratch.mainDirectory}/keep.txt`, 'utf8'), 'session scratch')
  await workspaces.removeScratch(forkId, workspace)
  let calls = 0
  const events: CoreEvent[] = []
  const session = new AgentSession({
    model: modelEntry(languageModel(async options => {
      assert.match(JSON.stringify(options.prompt), /Remote fixture instructions/)
      return calls++ === 0 ? toolStream('WriteFile', { path: 'agent.txt', content: 'remote agent' }) : finalStream('完成')
    })),
    providerConfig: { apiKey: 'fixture-only' }, sessionRecorder: journal, workspaceIO: io,
    promptContext: { projectDir: env.project, homeDir: env.remoteRoot, osPlatform: 'linux' },
    emit: event => events.push(event), requestApproval: async () => ({ approved: true }),
  })
  assert.equal(await session.handleUserMessage('写入远端项目'), 'completed')
  await session.dispose()
  assert.equal(await io.fs.readFile(`${env.project}/agent.txt`, 'utf8'), 'remote agent')
  assert.ok(events.some(event => event.type === 'checkpoint-created'))

  const interrupted = host.processes.spawn('sleep 60', env.project)
  await once(interrupted, 'spawn')
  const failed = once(interrupted, 'error')
  for (const client of env.clients) client.end()
  assert.match(String((await failed)[0]), /SSH|closed|连接/)
  await delay(50)
  assert.equal(env.connections.isConnected(env.id), false)
  assert.throws(() => io.fs.readFile(file), /未连接/)
  await env.store.save({ ...(await env.store.get(env.id)).connection, authentication: 'key', privateKeyPath: env.keyPath, secret: env.keyPassword, rememberSecret: false })
  await workspaces.connect(workspace)
  assert.equal(await io.fs.readFile(file, 'utf8'), 'hello\n世界\n')

  await io.fs.writeFile(`${host.componentDirectory}/keep.txt`, 'keep')
  await assert.rejects(env.connections.cleanup(env.id), /未知文件/)
  await assert.rejects(workspaces.prepare(runtime), /请先点击/)
  assert.equal(await readFile(join(env.root, '.cache/whycode-remote/keep.txt'), 'utf8'), 'keep')
  await env.connections.connect(env.id)
  await env.connections.host(env.id).io.fs.unlink(`${host.componentDirectory}/keep.txt`)
  const cleanup = env.connections.cleanup(env.id)
  await assert.rejects(env.connections.connect(env.id), /正在清理/)
  await cleanup
  assert.equal(env.connections.isConnected(env.id), false)
  await assert.rejects(readFile(join(env.root, '.cache/whycode-remote/.owner')), { code: 'ENOENT' })
  assert.equal(await readFile(join(env.root, 'project/目录/说明.txt'), 'utf8'), 'hello\n世界\n')
  assert.equal((await env.store.list()).length, 1)
  assert.equal(await readFile(join(env.root, '.cache/whycode-scratch', journal.sessionId, 'Main/keep.txt'), 'utf8'), 'session scratch')
  const commandCount = env.commands.length
  await assert.rejects(workspaces.prepare(runtime), /请先点击/)
  await assert.rejects(workspaces.select(host.target, env.project), /请先点击/)
  assert.equal(env.commands.length, commandCount)
  await assert.rejects(access(join(env.root, '.cache/whycode-remote')), { code: 'ENOENT' })

  await env.connections.connect(env.id)
  const componentDirectory = env.connections.host(env.id).componentDirectory
  const executable = (await io.fs.readdir(componentDirectory, { withFileTypes: true })).find(entry => entry.name.startsWith('host-'))!
  env.connections.disconnect(env.id)
  await assert.rejects(workspaces.connect(workspace), /请先点击/)
  await writeFile(join(env.root, '.cache/whycode-remote', executable.name), 'damaged component')
  await assert.rejects(env.connections.connect(env.id), /校验失败/)
  await env.connections.cleanup(env.id)
  await assert.rejects(readFile(join(env.root, '.cache/whycode-remote/.owner')), { code: 'ENOENT' })
  await env.connections.cleanup(env.id)
  await env.connections.connect(env.id)
  assert.equal(env.connections.isConnected(env.id), true)
  const original = await env.store.get(env.id)
  await env.connections.remove(env.id)
  assert.equal(env.connections.isConnected(env.id), false)
  assert.deepEqual(await env.store.list(), [])
  await assert.rejects(readFile(join(env.root, '.cache/whycode-remote/.owner')), { code: 'ENOENT' })
  assert.equal(await readFile(join(env.root, '.cache/whycode-scratch', journal.sessionId, 'Main/keep.txt'), 'utf8'), 'session scratch')
  assert.equal(await readFile(join(env.root, 'project/agent.txt'), 'utf8'), 'remote agent')

  await assert.rejects(workspaces.prepare(runtime), /连接不存在或已删除/)
  const replacement = await env.store.save({ ...original.connection, id: undefined, secret: original.secret, name: '重新添加的服务器' })
  assert.notEqual(replacement.id, env.id)
  await assert.rejects(workspaces.prepare(runtime), /连接不存在或已删除/)
  const changes: string[] = []
  env.connections.on('changed', () => changes.push(env.connections.status(replacement.id)))
  await env.connections.connect(replacement.id, env.fingerprint)
  assert.equal((await workspaces.select(host.target, env.project)).workingDirectory, env.project)
  assert.equal((await workspaces.prepare(runtime))?.scratch.rootDirectory, remote.scratch.rootDirectory)
  assert.equal(await io.fs.readFile(`${remote.scratch.mainDirectory}/keep.txt`, 'utf8'), 'session scratch')
  const continued = await tool('RunCommand').execute({ command: "printf 'resumed'", timeoutMs: 2_000 }, { ...ctx, workspaceIO: runtime.workspaceIO })
  assert.equal(continued.isError, false)
  assert.equal(continued.data, 'resumed')
  await workspaces.removeScratch(journal.sessionId, workspace)
  await assert.rejects(access(join(env.root, '.cache/whycode-scratch')), { code: 'ENOENT' })
  assert.ok((await workspaces.prepare(runtime))?.scratch.mainDirectory)
  await access(join(env.root, '.cache/whycode-scratch', journal.sessionId, 'Main'))
  env.connections.disconnect(replacement.id)
  assert.deepEqual(changes, ['connecting', 'connected', 'disconnected'])
})
