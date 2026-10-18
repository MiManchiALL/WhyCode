import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, it } from 'node:test'
import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import type { WorkspaceProcess } from '../../workspace/process.ts'
import { runCommandTool } from './index.ts'
import { readCommandOutputResult } from './output-result.ts'

class Process extends EventEmitter implements WorkspaceProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stops = 0
  close(code: number) {
    this.exitCode = code
    this.stdout.end()
    this.stderr.end()
    // 与 SSH 相同：生产端已关闭，消费端可能仍有背压缓冲。
    this.emit('close', code)
  }
  async terminate() { this.stops++; this.close(1); return true }
}

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'whycode-output-execution-'))
  roots.push(root)
  const child = new Process()
  const io: WorkspaceIO = { ...localWorkspaceIO, spawn: () => child }
  return { root, child, io, context: { projectDir: root, scratchDirectory: root, workspaceIO: io, additionalDirs: [root], abortSignal: new AbortController().signal } }
}

it('SSH 使用目标平台的路径和文件流，提前 close 也不丢掉缓冲尾部', async () => {
  const { root, child, context } = await setup()
  const remoteRoot = '/remote/scratch/Main'
  const localPath = (path: string) => {
    assert.ok(path === remoteRoot || path.startsWith(remoteRoot + '/'))
    return join(root, path.slice(remoteRoot.length))
  }
  const io: WorkspaceIO = { ...context.workspaceIO, identity: 'remote:test', path: posix, platform: 'linux', fs: {
    ...localWorkspaceIO.fs,
    lstat: path => localWorkspaceIO.fs.lstat(localPath(path)),
    mkdir: (path, options) => localWorkspaceIO.fs.mkdir(localPath(path), options),
    createWriteStream: (path, options) => localWorkspaceIO.fs.createWriteStream(localPath(path), options),
  } }
  const execution = runCommandTool.execute({ command: 'build' }, { ...context, workspaceIO: io, projectDir: '/project', scratchDirectory: remoteRoot })
  const text = ('完整行😀\n').repeat(20_000)
  child.stdout.write(Buffer.from(text))
  child.close(0)
  const result = await execution
  assert.equal(result.isError, false, result.data)
  const saved = readCommandOutputResult(result.data)!
  assert.ok(saved.fullOutputPath!.startsWith(remoteRoot + '/command-output/'))
  assert.equal(await readFile(localPath(saved.fullOutputPath!), 'utf8'), text)
  assert.ok(saved.output.split('\n').filter(Boolean).every(line => line === '完整行😀'))
})

it('超时停止进程后排空并关闭日志，返回超时原因及日志路径', async () => {
  const { child, context } = await setup()
  const execution = runCommandTool.execute({ command: 'build', timeoutMs: 1000 }, context)
  const text = 'timeout evidence\n'.repeat(4000)
  child.stdout.write(Buffer.from(text))
  const result = await execution
  assert.equal(child.stops, 1)
  assert.equal(result.isError, true)
  const saved = readCommandOutputResult(result.data)!
  assert.match(saved.diagnostic!, /命令超时/)
  assert.match(saved.diagnostic!, /结果未知/)
  assert.equal(await readFile(saved.fullOutputPath!, 'utf8'), text)
})

it('日志写入失败停止命令，错误不能伪装成成功或完整日志', async () => {
  const { child, context } = await setup()
  const file = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('ENOSPC: disk full')) } })
  context.workspaceIO = { ...context.workspaceIO, fs: { ...localWorkspaceIO.fs, createWriteStream: () => file } }
  const execution = runCommandTool.execute({ command: 'build' }, context)
  child.stdout.write(Buffer.from('evidence\n'.repeat(8000)))
  const result = await execution
  assert.equal(child.stops, 1)
  assert.equal(result.isError, true)
  const saved = readCommandOutputResult(result.data)!
  assert.match(saved.diagnostic!, /ENOSPC/)
  assert.equal(saved.fullOutputPath, undefined)
  assert.equal(file.closed, true)
})

it('文件关闭失败也报告未完整保存，即使命令已正常退出', async () => {
  const { child, context } = await setup()
  const file = new Writable({ write(_chunk, _encoding, callback) { callback() }, final(callback) { callback(new Error('close failed')) } })
  context.workspaceIO = { ...context.workspaceIO, fs: { ...localWorkspaceIO.fs, createWriteStream: () => file } }
  const execution = runCommandTool.execute({ command: 'build' }, context)
  child.stdout.end(Buffer.from('evidence\n'.repeat(8000)))
  child.close(0)
  const result = await execution
  assert.equal(result.isError, true)
  const saved = readCommandOutputResult(result.data)!
  assert.match(saved.diagnostic!, /close failed/)
  assert.equal(saved.fullOutputPath, undefined)
})
