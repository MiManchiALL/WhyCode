import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { posix } from 'node:path'
import { it } from 'node:test'
import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import type { WorkspaceProcess } from '../../workspace/process.ts'
import { globTool } from '../list-glob/index.ts'
import { grepTool } from '../grep/index.ts'
import { SEARCH_TIMEOUT_MS, withSearchDeadline } from './deadline.ts'

class SearchProcess extends EventEmitter implements WorkspaceProcess {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  exitCode: number | null = null
  signalCode = null
  stopped = false
  async terminate() {
    this.stopped = true
    this.stdout.end(); this.stderr.end()
    this.emit('close', 143)
    return true
  }
}

for (const tool of [globTool, grepTool]) {
  it(`${tool.name} 整次执行超时会停止远端进程并返回错误，后续搜索仍可用`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const parent = new AbortController()
    const child = new SearchProcess()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const io: WorkspaceIO = {
      ...localWorkspaceIO, path: posix, platform: 'linux', identity: 'ssh:test',
      fs: {
        ...localWorkspaceIO.fs, realpath: async path => path,
        stat: async () => ({ size: 0, mode: 0, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false }),
        readdir: async () => assert.fail('远端搜索不能遍历 SFTP 目录'),
        readFile: async () => assert.fail('远端搜索不能下载源文件'),
      },
      ripgrep: () => { started(); return child },
    }
    const ctx = { workspaceIO: io, projectDir: '/project', additionalDirs: [], abortSignal: parent.signal }
    const result = tool.execute({ pattern: 'needle' }, ctx)
    await ready
    t.mock.timers.tick(SEARCH_TIMEOUT_MS)
    assert.deepEqual(await result, { data: '搜索超时（30 秒）；请缩小搜索目录或匹配范围后重试', isError: true })
    assert.equal(child.stopped, true)
    assert.equal(parent.signal.aborted, false)

    io.ripgrep = () => {
      const next = new SearchProcess()
      setImmediate(() => { next.stdout.end(); next.stderr.end(); next.emit('close', 1) })
      return next
    }
    assert.equal((await tool.execute({ pattern: 'needle' }, ctx)).isError, false)
  })
}

it('路径检查和无进程回退也受同一个总超时约束', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release!: () => void
  const io = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs, realpath: async (path: string) => {
    await new Promise<void>(resolve => { release = resolve }); return path
  } } }
  const result = globTool.execute({ pattern: '*.ts' }, { workspaceIO: io, projectDir: '/project', additionalDirs: [], abortSignal: new AbortController().signal })
  t.mock.timers.tick(SEARCH_TIMEOUT_MS)
  assert.equal((await result).isError, true)
  release()
})

it('用户停止和搜索超时保持不同语义', async () => {
  const parent = new AbortController()
  const reason = new Error('用户停止')
  const result = withSearchDeadline({ projectDir: '.', additionalDirs: [], abortSignal: parent.signal }, async () => {
    parent.abort(reason)
    return { data: '', isError: false }
  })
  await assert.rejects(result, reason)
})
