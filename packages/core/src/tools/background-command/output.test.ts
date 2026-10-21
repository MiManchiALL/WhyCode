import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, type Writable } from 'node:stream'
import { setImmediate } from 'node:timers/promises'
import { it, type TestContext } from 'node:test'
import { localWorkspaceIO } from '../../workspace/io.ts'
import { createCommandTools } from './index.ts'
import { CommandSessionManager } from './manager.ts'
import { CommandTaskStorage } from './storage.ts'
import type { CommandTaskTerminalNotification } from './types.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'

it('超过 8 MiB 的后台日志完整保存，整行续读及崩溃恢复不丢失中段和末尾', { timeout: 20_000 }, async t => {
  const env = await fixture(t)
  const line = `日志😀${'x'.repeat(1000)}\n`
  const batch = Buffer.from(line.repeat(32))
  for (let i = 0; i < 290; i++) {
    if (!env.child.stdout.write(batch)) await once(env.child.stdout, 'drain')
  }
  env.finish(0)
  const terminal = await env.terminal.promise
  const expected = line.repeat(32 * 290)
  assert.equal(terminal.task.status, 'completed')
  assert.equal(terminal.task.outputBytes, Buffer.byteLength(expected))
  assert.ok(terminal.task.outputBytes > 8 * 1024 * 1024)
  assert.equal(await readFile(env.log, 'utf8'), expected)
  let offset = 0
  let restored = ''
  do {
    const chunk = await env.manager.readOutput(SESSION, env.task.id, offset)
    assert.equal(chunk.offset, offset)
    assert.ok(chunk.nextOffset > offset)
    assert.equal(chunk.partialLine, false)
    assert.ok(chunk.output.endsWith('\n'))
    assert.doesNotMatch(chunk.output, /\uFFFD/)
    restored += chunk.output
    offset = chunk.nextOffset
    if (!chunk.hasMore) break
  } while (offset < terminal.task.outputBytes)
  assert.equal(restored, expected)

  // 模拟应用在最后一次 manifest 更新之前崩溃，日志已落盘但长度仍旧。
  const manifest = join(env.root, SESSION, `${env.task.id}.json`)
  await writeFile(manifest, JSON.stringify({ ...terminal.task, status: 'running', outputBytes: 0 }))
  const reopened = new CommandSessionManager(env.root)
  t.after(() => reopened.shutdown())
  const [recovered] = await reopened.list(SESSION)
  assert.equal(recovered?.status, 'interrupted')
  assert.equal(recovered?.outputBytes, Buffer.byteLength(expected))
  assert.equal((await reopened.readOutput(SESSION, env.task.id, offset - Buffer.byteLength(line))).output, line)
  await reopened.removeSession(SESSION)
  assert.deepEqual(await readdir(env.root), [])
})

it('分别解码两路流，任意偏移及超长单行续读不切碎中文或 emoji', async t => {
  const env = await fixture(t)
  const text = '中😀'.repeat(12_000)
  const bytes = Buffer.from(text)
  env.child.stdout.write(bytes.subarray(0, 2))
  env.child.stderr.write('错误\n')
  env.child.stdout.write(bytes.subarray(2, 5))
  env.child.stdout.write(bytes.subarray(5))
  env.finish(0)
  await env.terminal.promise
  const expected = `错误\n${text}`
  assert.equal(await readFile(env.log, 'utf8'), expected)
  let offset = 0
  let actual = ''
  let sawFragment = false
  while (true) {
    const chunk = await env.manager.readOutput(SESSION, env.task.id, offset)
    assert.doesNotMatch(chunk.output, /\uFFFD/)
    assert.ok(chunk.nextOffset > offset)
    actual += chunk.output
    sawFragment ||= chunk.partialLine
    offset = chunk.nextOffset
    if (!chunk.hasMore) break
  }
  assert.ok(sawFragment)
  assert.equal(actual, expected)
  const arbitrary = await env.manager.readOutput(SESSION, env.task.id, Buffer.byteLength('错误\n中') + 2)
  assert.ok(arbitrary.output.startsWith('😀'))
  assert.doesNotMatch(arbitrary.output, /\uFFFD/)
})

it('读取与最后一段输出交错时，终态不能误报日志已读完', async t => {
  const env = await fixture(t)
  const read = CommandTaskStorage.prototype.readOutput
  const entered = deferred<void>()
  const release = deferred<void>()
  t.after(() => release.resolve())
  t.mock.method(CommandTaskStorage.prototype, 'readOutput', async function (this: CommandTaskStorage, ...args: Parameters<typeof read>) {
    const chunk = await read.apply(this, args)
    entered.resolve()
    await release.promise
    return chunk
  })
  const reading = env.manager.readOutput(SESSION, env.task.id)
  await entered.promise
  env.child.stdout.write('last output\n')
  env.finish(0)
  await env.manager.shutdown()
  release.resolve()
  const chunk = await reading
  assert.equal(chunk.task.status, 'completed')
  assert.equal(chunk.output, '')
  assert.equal(chunk.hasMore, true)
  assert.equal((await env.manager.readOutput(SESSION, env.task.id, chunk.nextOffset)).output, 'last output\n')
})

it('慢磁盘会暂停输出读取，关闭进程后仍须排空日志才能交付终态', async t => {
  const entered = deferred<void>()
  const release = deferred<void>()
  t.after(() => release.resolve())
  const create = CommandTaskStorage.prototype.createOutput
  t.mock.method(CommandTaskStorage.prototype, 'createOutput', async function (this: CommandTaskStorage, ...args: Parameters<typeof create>) {
    const output = await create.apply(this, args)
    const write = output._write.bind(output)
    t.mock.method(output, '_write', (...[chunk, encoding, callback]: Parameters<Writable['_write']>) => {
      entered.resolve()
      void release.promise.then(() => write(chunk, encoding, callback))
    })
    return output
  })
  const env = await fixture(t)
  env.child.stdout.write(Buffer.alloc(128 * 1024, 97))
  await entered.promise
  assert.ok(env.child.stdout.isPaused())
  assert.equal((await env.manager.list(SESSION))[0]?.outputBytes, 0)
  env.finish(0)
  await setImmediate()
  assert.equal((await env.manager.list(SESSION))[0]?.status, 'running')
  release.resolve()
  assert.equal((await env.terminal.promise).task.status, 'completed')
  assert.equal((await readFile(env.log)).length, 128 * 1024)
})

it('写盘错误停止进程并报告日志不完整，不能显示成功或遗留日志句柄', async t => {
  const create = CommandTaskStorage.prototype.createOutput
  t.mock.method(CommandTaskStorage.prototype, 'createOutput', async function (this: CommandTaskStorage, ...args: Parameters<typeof create>) {
    const output = await create.apply(this, args)
    t.mock.method(output, '_write', (...[_chunk, _encoding, callback]: Parameters<Writable['_write']>) => callback(new Error('ENOSPC')))
    return output
  })
  const env = await fixture(t)
  env.child.stdout.write('cannot save')
  const { task } = await env.terminal.promise
  assert.equal(task.status, 'failed')
  assert.match(task.failureReason!, /输出日志不完整.*ENOSPC/)
  assert.equal(env.stops(), 1)
  await env.manager.removeSession(SESSION)
  assert.deepEqual(await readdir(env.root), [])
})

it('write 不添加换行，close 可先写末段再发 EOF，查询和输入均按会话隔离', async t => {
  const env = await fixture(t)
  const tool = createCommandTools(env.manager, SESSION).manageCommand
  const ctx = { projectDir: env.root, additionalDirs: [], abortSignal: new AbortController().signal }
  let input = ''
  env.child.stdin.setEncoding('utf8').on('data', chunk => { input += chunk })
  await tool.execute({ action: 'write', taskId: env.task.id, input: 'first' }, ctx)
  assert.equal(input, 'first')
  const end = once(env.child.stdin, 'end')
  const result = await tool.execute({ action: 'close', taskId: env.task.id, input: '\nlast' }, ctx)
  await end
  assert.equal(input, 'first\nlast')
  assert.match(result.data, /EOF/)
  assert.equal((await env.manager.list(SESSION))[0]?.status, 'running')
  await assert.rejects(tool.execute({ action: 'write', taskId: env.task.id, input: 'late' }, ctx), /已不接受输入/)
  const other = createCommandTools(env.manager, 'other-session').manageCommand
  assert.match((await other.execute({ action: 'list' }, ctx)).data, /没有后台命令/)
  for (const action of ['read', 'write', 'close', 'stop']) {
    await assert.rejects(other.execute({ action, taskId: env.task.id, input: 'forbidden' }, ctx), /当前会话不存在/)
  }
})

it('取消阻塞的 stdin 等待可结束工具调用，保留后台进程且不重发输入', async t => {
  const env = await fixture(t)
  const entered = deferred<void>()
  let complete!: (error?: Error | null) => void
  let writes = 0
  t.mock.method(env.child.stdin, '_write', (...[_chunk, _encoding, callback]: Parameters<Writable['_write']>) => {
    writes++
    complete = callback
    entered.resolve()
  })
  const abort = new AbortController()
  const writing = env.manager.writeInput(SESSION, env.task.id, 'pending', false, abort.signal)
  await entered.promise
  abort.abort()
  await assert.rejects(writing, /可能已被进程接收/)
  assert.equal((await env.manager.list(SESSION))[0]?.status, 'running')
  assert.equal(writes, 1)
  complete()
})

it('stdin 写入错误交还调用方，不产生宿主未处理异常或伪造进程终态', async t => {
  const env = await fixture(t)
  t.mock.method(env.child.stdin, '_write', (...[_chunk, _encoding, callback]: Parameters<Writable['_write']>) => callback(new Error('EPIPE')))
  await assert.rejects(env.manager.writeInput(SESSION, env.task.id, 'closed pipe', true), /EPIPE/)
  await setImmediate()
  const [task] = await env.manager.list(SESSION)
  assert.equal(task?.status, 'running')
  assert.equal(task?.canWrite, false)
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-command-log-'))
  const terminal = deferred<CommandTaskTerminalNotification>()
  let stops = 0
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    async terminate() { stops++; finish(143); return true },
  })
  const finish = (code: number) => {
    child.stdout.end()
    child.stderr.end()
    child.exitCode = code
    child.emit('close', code)
  }
  const manager = new CommandSessionManager(root, { onBackgroundTaskTerminal: terminal.resolve })
  t.after(async () => {
    if (child.exitCode === null) finish(143)
    await manager.shutdown()
    child.stdin.destroy()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const task = await manager.start({
    sessionId: SESSION, command: 'test-process', cwd: root,
    workspaceIO: { ...localWorkspaceIO, spawn: () => { queueMicrotask(() => child.emit('spawn')); return child } },
  })
  await manager.armTerminalNotification(SESSION, task.id)
  return { root, task, manager, child, finish, terminal, stops: () => stops, log: join(root, SESSION, `${task.id}.log`) }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
