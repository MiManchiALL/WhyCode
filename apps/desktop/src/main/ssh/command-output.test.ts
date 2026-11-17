import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { it } from 'node:test'
import { BUILTIN_TOOLS, type WorkspaceBinding } from '@whycode/core'
import { readCommandOutputResult } from '@whycode/core/command-output'
import { sshFixture } from './ssh-test-fixture.ts'
import { SshWorkspaces } from './workspaces.ts'

const run = BUILTIN_TOOLS.find(tool => tool.name === 'RunCommand')!

it('服务端合并双流 UTF-8，进度与完整日志一致，停止后日志也可分页读取和清理', {
  skip: process.env.WHYCODE_SSH_INTEGRATION !== '1', timeout: 90_000,
}, async t => {
  const env = await sshFixture(t, true)
  await env.connections.connect(env.id, env.fingerprint)
  const host = env.connections.host(env.id)
  const io = env.connections.io(host.target)
  const sessionId = randomUUID()
  const scratchDirectory = posix.join(env.remoteRoot, '.cache/whycode-scratch', sessionId, 'Main')
  await io.fs.mkdir(scratchDirectory, { recursive: true })
  const context = { workspaceIO: io, projectDir: env.project, scratchDirectory, additionalDirs: [scratchDirectory], abortSignal: new AbortController().signal }
  const live = createHash('sha256')
  const result = await run.execute({
    command: `(awk 'BEGIN {for(i=0;i<60000;i++) printf "stdout-%06d 中文😀\\n", i}') & (awk 'BEGIN {for(i=0;i<60000;i++) printf "stderr-%06d 汉字🌟\\n", i}' >&2) & wait`,
    timeoutMs: 60_000,
  }, { ...context, onProgress: text => { live.update(text) } })
  assert.equal(result.isError, false, result.data)
  const saved = readCommandOutputResult(result.data)!
  const full = await io.fs.readFile(saved.fullOutputPath!, 'utf8')
  assert.equal(live.digest('hex'), createHash('sha256').update(full).digest('hex'))
  assert.equal(Buffer.byteLength(full), saved.totalBytes)
  assert.equal(saved.totalLines, 120_000)
  assert.equal([...full.matchAll(/😀/gu)].length, 60_000)
  assert.equal([...full.matchAll(/🌟/gu)].length, 60_000)
  assert.doesNotMatch(full, /�/u)
  const page = await BUILTIN_TOOLS.find(tool => tool.name === 'ReadFile')!.execute({ path: saved.fullOutputPath!, offset: 60_000, limit: 2 }, context)
  assert.equal(page.isError, false, page.data)
  assert.match(page.data, /60000\t/)
  const abort = new AbortController()
  const stopped = await run.execute({ command: "head -c 65536 /dev/zero | tr '\\0' x; printf '\\nready\\n'; sleep 20" }, {
    ...context, abortSignal: abort.signal, onProgress: text => { if (text.includes('ready')) abort.abort('user-cancel') },
  })
  const partial = readCommandOutputResult(stopped.data)!
  assert.ok(stopped.isError)
  assert.match(partial.diagnostic!, /用户已停止/u)
  assert.notEqual(partial.fullOutputPath, saved.fullOutputPath)
  assert.equal(await io.fs.readFile(partial.fullOutputPath!, 'utf8'), 'x'.repeat(65536) + '\nready\n')

  const workspace: WorkspaceBinding = { mode: 'ssh', label: 'fixture', target: host.target, workingDirectory: env.project }
  await new SshWorkspaces(env.connections).removeScratch(sessionId, workspace)
  await assert.rejects(access(join(env.root, '.cache/whycode-scratch', sessionId)), { code: 'ENOENT' })

  await writeFile(join(env.root, 'project', 'command-output'), '既有文件')
  const blocked = { ...context, scratchDirectory: env.project }
  assert.deepEqual(await run.execute({ command: 'printf ok' }, blocked), { isError: false, data: 'ok' })
  const failed = await run.execute({ command: "head -c 65536 /dev/zero | tr '\\0' x; sleep 20" }, blocked)
  assert.ok(failed.isError)
  const failure = readCommandOutputResult(failed.data)!
  assert.match(failure.diagnostic!, /完整输出未保存/u)
  assert.equal(failure.fullOutputPath, undefined)
  assert.equal(await readFile(join(env.root, 'project', 'command-output'), 'utf8'), '既有文件')
})
