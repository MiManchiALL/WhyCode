import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable, Writable } from 'node:stream'
import { afterEach, it } from 'node:test'
import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import { visibleToolResult } from '../../events.ts'
import { CommandOutput, captureCommandOutput } from './output.ts'
import { COMMAND_PREVIEW_BYTES, COMMAND_PREVIEW_LINES, readCommandOutputResult, serializeCommandOutputResult } from './output-result.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-command-output-'))
  roots.push(root)
  return root
}
const empty = () => Readable.from([])
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('短输出与恰好达到字节上限的输出不创建日志，超出一个字节保留完整前缀', async () => {
  const root = await scratch()
  for (const text of ['中文😀\r\n最后一行', 'x'.repeat(COMMAND_PREVIEW_BYTES)]) {
    const output = new CommandOutput(localWorkspaceIO, root)
    await captureCommandOutput([Readable.from([Buffer.from(text)]), empty()], output)
    assert.equal(output.preview(), text)
    assert.equal(output.fullOutputPath, undefined)
  }
  assert.deepEqual(await readdir(root), [])
  const output = new CommandOutput(localWorkspaceIO, root)
  await captureCommandOutput([Readable.from([Buffer.alloc(COMMAND_PREVIEW_BYTES, 'x'), Buffer.from('y')]), empty()], output)
  assert.equal(output.preview(), '')
  assert.equal(await readFile(output.fullOutputPath!, 'utf8'), 'x'.repeat(COMMAND_PREVIEW_BYTES) + 'y')
})

it('行数上限独立于字节上限，CRLF 和最后没有换行的行保持完整', async () => {
  const root = await scratch()
  const lines = Array.from({ length: COMMAND_PREVIEW_LINES + 3 }, (_, i) => `行${i}😀`)
  for (const ending of ['', '\r\n']) {
    const text = lines.join('\r\n') + ending
    const output = new CommandOutput(localWorkspaceIO, root)
    await captureCommandOutput([Readable.from([Buffer.from(text)]), empty()], output)
    assert.equal(output.totalLines, lines.length)
    assert.equal(output.preview(), lines.slice(-COMMAND_PREVIEW_LINES).join('\r\n') + ending)
    assert.equal(await readFile(output.fullOutputPath!, 'utf8'), text)
  }
})

it('超长单行不展示半行，后续正常行仍可预览且日志完整', async () => {
  const root = await scratch()
  const longLine = '中文😀'.repeat(COMMAND_PREVIEW_BYTES)
  for (const suffix of ['', '\r\n', '\r\n最后一行😀\r\n']) {
    const output = new CommandOutput(localWorkspaceIO, root)
    const text = `头部\r\n${longLine}${suffix}`
    const chunks = (function* () {
      const buffer = Buffer.from(text)
      for (let at = 0; at < buffer.length; at += 16_383) yield buffer.subarray(at, at + 16_383)
    })()
    await captureCommandOutput([Readable.from(chunks), empty()], output)
    assert.equal(output.preview(), suffix.endsWith('最后一行😀\r\n') ? '最后一行😀\r\n' : '')
    assert.equal(await readFile(output.fullOutputPath!, 'utf8'), text)
  }
})

it('stdout/stderr 各自解码，交错到达的多字节字符不会互相污染', async () => {
  const root = await scratch()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const progress: string[] = []
  const output = new CommandOutput(localWorkspaceIO, root, text => progress.push(text))
  const done = captureCommandOutput([stdout, stderr], output)
  const chinese = Buffer.from('汉😀\n')
  stdout.write(chinese.subarray(0, 1))
  stderr.write(Buffer.from('错'))
  stdout.write(chinese.subarray(1, 5))
  stderr.end(Buffer.from('误\n'))
  stdout.end(chinese.subarray(5))
  await done
  assert.equal(output.preview(), '错汉误\n😀\n')
  assert.equal(progress.join(''), output.preview())
  assert.doesNotMatch(output.preview(), /�/)
})

it('32 MiB 输出完整落盘，头、中、尾和摘要一致，预览仍有界', async () => {
  const root = await scratch()
  const expected = createHash('sha256')
  const chunks = (function* () {
    for (let i = 0; i < 512; i++) {
      const chunk = Buffer.from(`${String(i).padStart(4, '0')}:${'x'.repeat(65_530)}\n`)
      expected.update(chunk)
      yield chunk
    }
  })()
  const output = new CommandOutput(localWorkspaceIO, root)
  await captureCommandOutput([Readable.from(chunks), empty()], output)
  const path = output.fullOutputPath!
  assert.equal((await stat(path)).size, 32 * 1024 * 1024)
  const actual = createHash('sha256')
  for await (const chunk of createReadStream(path)) actual.update(chunk)
  assert.equal(actual.digest('hex'), expected.digest('hex'))
  assert.equal(output.totalLines, 512)
  assert.ok(Buffer.byteLength(output.preview()) <= COMMAND_PREVIEW_BYTES)
  assert.equal(output.preview(), '', '每行均超限时不切出伪造的半行')
})

it('慢磁盘施加背压，不把全部生产者输出排进内存，并等待文件真正关闭', async () => {
  const root = await scratch()
  const blocked = deferred()
  const release = deferred()
  const finalizing = deferred()
  const close = deferred()
  let first = true
  let produced = 0
  let bytes = 0
  const file = new Writable({
    highWaterMark: 1024,
    write(chunk, _encoding, callback) {
      bytes += chunk.length
      if (!first) { callback(); return }
      first = false
      blocked.resolve()
      void release.promise.then(() => callback())
    },
    final(callback) { finalizing.resolve(); void close.promise.then(() => callback()) },
  })
  const io: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, createWriteStream: () => file } }
  const source = new Readable({ highWaterMark: 1024, read() {
    if (produced === 128) { this.push(null); return }
    produced++
    this.push(Buffer.alloc(65_536, 'x'))
  } })
  const output = new CommandOutput(io, root)
  let settled = false
  const done = captureCommandOutput([source, empty()], output).then(() => { settled = true })
  await blocked.promise
  assert.ok(produced < 8, `生产端应暂停，实际已产生 ${produced} 块`)
  assert.equal(settled, false)
  release.resolve()
  await finalizing.promise
  assert.equal(settled, false)
  assert.equal(output.fullOutputPath, undefined)
  close.resolve()
  await done
  assert.equal(bytes, 128 * 65_536)
  assert.ok(output.fullOutputPath)
  assert.equal(file.closed, true)
})

it('磁盘写入错误释放所有流，不把部分日志报告为完整日志', async () => {
  const root = await scratch()
  const file = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('ENOSPC')) } })
  const io: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, createWriteStream: () => file } }
  const source = Readable.from([Buffer.alloc(COMMAND_PREVIEW_BYTES + 1)])
  const stderr = new PassThrough()
  const output = new CommandOutput(io, root)
  await assert.rejects(captureCommandOutput([source, stderr], output), /ENOSPC/)
  assert.equal(source.destroyed, true)
  assert.equal(stderr.destroyed, true)
  assert.equal(file.closed, true)
  assert.equal(output.fullOutputPath, undefined)
})

it('文件流在背压期间无 error 地关闭，也能结束等待并释放生产端', { timeout: 2000 }, async () => {
  const root = await scratch()
  const writing = deferred()
  const file = new Writable({ highWaterMark: 1, write() { writing.resolve() } })
  const io: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, createWriteStream: () => file } }
  const source = Readable.from([Buffer.alloc(COMMAND_PREVIEW_BYTES + 1)])
  const output = new CommandOutput(io, root)
  const done = captureCommandOutput([source, empty()], output)
  await writing.promise
  file.destroy()
  await assert.rejects(done, /Premature close/)
  assert.equal(source.destroyed, true)
  assert.equal(output.closed, true)
  assert.equal(output.fullOutputPath, undefined)
})

it('准备日志目录时失败或取消，也要等待在途文件操作结束', async () => {
  const root = await scratch()
  const entered = deferred()
  const release = deferred()
  let opened = false
  const io: WorkspaceIO = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs,
    mkdir: async (path, options) => { entered.resolve(); await release.promise; return localWorkspaceIO.fs.mkdir(path, options) },
    createWriteStream: () => { opened = true; return new PassThrough() },
  } }
  const output = new CommandOutput(io, root)
  let settled = false
  const done = captureCommandOutput([Readable.from([Buffer.alloc(COMMAND_PREVIEW_BYTES + 1)]), empty()], output)
    .finally(() => { settled = true })
  await entered.promise
  output.destroy(new Error('cancelled'))
  assert.equal(settled, false)
  release.resolve()
  await assert.rejects(done, /cancelled/)
  assert.equal(opened, false)
})

it('JSON 转义后的工具结果仍有界，不拆行且保留可重定位的日志路径', () => {
  const data = serializeCommandOutputResult({ type: 'command-output', output: ('\0'.repeat(40) + '\n').repeat(1000),
    totalBytes: 80_000, totalLines: 2000, fullOutputPath: '/scratch/command-output/test.log', diagnostic: '[退出码 1]' })
  assert.ok(data.length < 64 * 1024)
  assert.equal(visibleToolResult(data), data)
  const result = readCommandOutputResult(data)!
  assert.ok(result.output.split('\n').filter(Boolean).every(line => line.length === 40))
  assert.equal(result.fullOutputPath, '/scratch/command-output/test.log')
  assert.equal(result.diagnostic, '[退出码 1]')
})

it('日志目录被链接替换时拒绝落盘，不写入用户的其它目录', async () => {
  const root = await scratch()
  const outside = await scratch()
  const working = join(root, 'Main')
  await mkdir(working)
  await symlink(outside, join(working, 'command-output'), process.platform === 'win32' ? 'junction' : 'dir')
  const output = new CommandOutput(localWorkspaceIO, working)
  await assert.rejects(captureCommandOutput([Readable.from([Buffer.alloc(COMMAND_PREVIEW_BYTES + 1)]), empty()], output), /不是普通目录/)
  assert.equal(output.fullOutputPath, undefined)
  assert.deepEqual(await readdir(outside), [])
})
