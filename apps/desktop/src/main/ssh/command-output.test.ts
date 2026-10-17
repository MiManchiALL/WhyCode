import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { it } from 'node:test'
import { BUILTIN_TOOLS, type WorkspaceIO, type WorkspaceProcess, type WorkspaceBinding } from '@whycode/core'
import { readCommandOutputResult } from '@whycode/core/command-output'
import { sshFixture } from './ssh-test-fixture.ts'
import { SshWorkspaces } from './workspaces.ts'

it('SSH 日志通过真实 SFTP 连续落盘并随所属会话清理，不创建本机日志副本', { timeout: 15_000 }, async t => {
  const env = await sshFixture(t)
  await env.store.trust(env.id, env.fingerprint)
  const connection = (await env.store.get(env.id)).connection
  const workspace: WorkspaceBinding = { mode: 'ssh', label: connection.name, workingDirectory: env.project,
    target: `ssh:${connection.username}@${connection.host}:${connection.port}#${env.fingerprint}` }
  const sessionId = randomUUID()
  const text = '中文😀 long output\n'.repeat(6000)
  const logs = await env.connections.withFiles(env.id, async (fs, home) => {
    const scratchDirectory = posix.join(home, '.cache/whycode-scratch', sessionId, 'Main')
    await fs.mkdir(scratchDirectory, { recursive: true })
    const io: WorkspaceIO = { identity: workspace.target, platform: 'linux', path: posix, fs,
      spawn: () => {
        const child: WorkspaceProcess = Object.assign(new EventEmitter(), {
          stdin: new PassThrough(), stdout: Readable.from([Buffer.from(text)]), stderr: Readable.from([]),
          exitCode: 0, signalCode: null, terminate: async () => true,
        })
        queueMicrotask(() => child.emit('close', 0))
        return child
      },
    }
    const paths: string[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await BUILTIN_TOOLS.find(tool => tool.name === 'RunCommand')!.execute({ command: 'build' }, {
        workspaceIO: io, projectDir: env.project, scratchDirectory, additionalDirs: [scratchDirectory], abortSignal: new AbortController().signal,
      })
      assert.equal(result.isError, false, result.data)
      const saved = readCommandOutputResult(result.data)!
      assert.ok(saved.fullOutputPath!.startsWith(scratchDirectory + '/command-output/'))
      assert.equal(await fs.readFile(saved.fullOutputPath!, 'utf8'), text)
      paths.push(saved.fullOutputPath!)
    }
    return paths
  })
  assert.notEqual(logs[0], logs[1])
  for (const path of logs) assert.equal(await readFile(join(env.root, path.slice(env.remoteRoot.length)), 'utf8'), text)
  await new SshWorkspaces(env.connections).removeScratch(sessionId, workspace)
  await assert.rejects(access(join(env.root, '.cache/whycode-scratch', sessionId)), { code: 'ENOENT' })
  assert.equal(env.commands.length, 0)
})

it('真实 Linux 命令的双流 UTF-8 大日志经 ACK 背压完整落盘且可分页读取', {
  skip: process.env.WHYCODE_SSH_INTEGRATION !== '1', timeout: 90_000,
}, async t => {
  const env = await sshFixture(t, true)
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const io = host.io
  const sessionId = randomUUID()
  const scratchDirectory = posix.join(env.remoteRoot, '.cache/whycode-scratch', sessionId, 'Main')
  await io.fs.mkdir(scratchDirectory, { recursive: true })
  const context = { workspaceIO: io, projectDir: env.project, scratchDirectory, additionalDirs: [scratchDirectory], abortSignal: new AbortController().signal }
  const result = await BUILTIN_TOOLS.find(tool => tool.name === 'RunCommand')!.execute({
    command: `(awk 'BEGIN {for(i=0;i<60000;i++) printf "stdout-%06d 中文😀\\n", i}') & (awk 'BEGIN {for(i=0;i<60000;i++) printf "stderr-%06d 汉字🌟\\n", i}' >&2) & wait`,
    timeoutMs: 60_000,
  }, context)
  assert.equal(result.isError, false, result.data)
  const saved = readCommandOutputResult(result.data)!
  const full = await io.fs.readFile(saved.fullOutputPath!, 'utf8')
  assert.equal(Buffer.byteLength(full), saved.totalBytes)
  assert.equal(saved.totalLines, 120_000)
  assert.equal([...full.matchAll(/😀/gu)].length, 60_000)
  assert.equal([...full.matchAll(/🌟/gu)].length, 60_000)
  assert.doesNotMatch(full, /�/u)
  const page = await BUILTIN_TOOLS.find(tool => tool.name === 'ReadFile')!.execute({ path: saved.fullOutputPath!, offset: 60_000, limit: 2 }, context)
  assert.equal(page.isError, false, page.data)
  assert.match(page.data, /60000\t/)
  const workspace: WorkspaceBinding = { mode: 'ssh', label: 'fixture', target: host.target, workingDirectory: env.project }
  await new SshWorkspaces(env.connections).removeScratch(sessionId, workspace)
  await assert.rejects(access(join(env.root, '.cache/whycode-scratch', sessionId)), { code: 'ENOENT' })
})
