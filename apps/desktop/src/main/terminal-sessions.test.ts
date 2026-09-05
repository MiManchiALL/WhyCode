import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_TERMINALS, type TerminalEvent } from '../shared/terminal.ts'
import { TerminalSessions, type TerminalPty } from './terminal-sessions.ts'

class FakePty implements TerminalPty {
  cols = 80
  rows = 24
  paused = false
  kills = 0
  input = ''
  private readonly data = new Set<(data: string) => void>()
  private readonly exit = new Set<(event: { exitCode: number }) => void>()
  onData = (listener: (data: string) => void) => {
    this.data.add(listener)
    return { dispose: () => { this.data.delete(listener) } }
  }
  onExit = (listener: (event: { exitCode: number }) => void) => {
    this.exit.add(listener)
    return { dispose: () => { this.exit.delete(listener) } }
  }
  write(data: string | Buffer): void { this.input += data.toString() }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows }
  pause(): void { this.paused = true }
  resume(): void { this.paused = false }
  kill(): void { this.kills++ }
  output(data: string): void { for (const listener of this.data) listener(data) }
  finish(exitCode: number): void { for (const listener of this.exit) listener({ exitCode }) }
  get listeners(): number { return this.data.size + this.exit.size }
}

const owner = { windowId: 1, runtimeId: 'draft', sessionId: null }

describe('用户终端资源', () => {
  it('在宿主给出的目录启动，独立路由输入、尺寸、退出并验证窗口所有权', async () => {
    const ptys: FakePty[] = []
    const directories: string[] = []
    const events: TerminalEvent[] = []
    const closed: string[] = []
    const sessions = new TerminalSessions(async (cwd) => {
      directories.push(cwd)
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    })
    const first = await sessions.create(owner, async () => 'E:\\项目 空格', (e) => events.push(e), (id) => closed.push(id))
    const second = await sessions.create(owner, async () => 'E:\\another', (e) => events.push(e), (id) => closed.push(id))
    assert.deepEqual(directories, ['E:\\项目 空格', 'E:\\another'])
    assert.notEqual(first.id, second.id)
    assert.notEqual(first.title, second.title)
    const a = ptys[0]!
    const b = ptys[1]!
    assert.equal(a.paused, true)
    sessions.control(2, { terminalId: first.id, type: 'ready' })
    assert.equal(a.paused, true)
    sessions.control(1, { terminalId: first.id, type: 'ready' })
    sessions.control(1, { terminalId: first.id, type: 'input', data: '中文😀\r\x03' })
    assert.equal(a.input, '中文😀\r\x03')
    assert.equal(b.input, '')
    sessions.control(2, { terminalId: first.id, type: 'input', data: 'wrong' })
    sessions.control(1, { terminalId: first.id, type: 'resize', cols: 123, rows: 35 })
    for (const dimension of [0, -1, 501, 2.5, NaN, Infinity, '80']) {
      sessions.control(1, { terminalId: first.id, type: 'resize', cols: dimension, rows: 35 })
    }
    assert.deepEqual([a.cols, a.rows, b.cols, b.rows], [123, 35, 80, 24])
    a.output('末行')
    a.finish(7)
    assert.deepEqual(events, [
      { terminalId: first.id, type: 'data', data: '末行' },
      { terminalId: first.id, type: 'exit', exitCode: 7 },
    ])
    sessions.control(1, { terminalId: first.id, type: 'input', data: 'ignored' })
    assert.equal(a.input, '中文😀\r\x03')
    sessions.close(2, second.id)
    assert.equal(b.kills, 0)
    sessions.closeOwner({ windowId: 1 })
    sessions.closeOwner({})
    assert.equal(a.kills, 0)
    assert.equal(b.kills, 1)
    assert.equal(a.listeners + b.listeners, 0)
    assert.deepEqual(closed, [first.id, second.id])
  })

  it('输出积压暂停 PTY，只有有效消费确认到达低水位才继续', async () => {
    const pty = new FakePty()
    const sessions = new TerminalSessions(async () => pty)
    const terminal = await sessions.create(owner, async () => 'cwd', () => {}, () => {})
    const control = (type: 'ack', length: unknown) => sessions.control(1, { terminalId: terminal.id, type, length })
    sessions.control(1, { terminalId: terminal.id, type: 'ready' })
    pty.output('a'.repeat(64 * 1024))
    assert.equal(pty.paused, false)
    pty.output('中'.repeat(64 * 1024))
    assert.equal(pty.paused, true)
    for (const invalid of [-1, 0, 0.5, Infinity, NaN, 1024 * 1024, '65536']) control('ack', invalid)
    sessions.control(2, { terminalId: terminal.id, type: 'ack', length: 128 * 1024 })
    assert.equal(pty.paused, true)
    control('ack', 64 * 1024)
    assert.equal(pty.paused, true)
    control('ack', 64 * 1024)
    assert.equal(pty.paused, false)
    sessions.closeOwner({})
  })

  it('并发启动先占容量；目录准备期间关闭不会遗留 shell', async () => {
    let resolve!: (cwd: string) => void
    const directory = new Promise<string>((done) => { resolve = done })
    let spawns = 0
    const sessions = new TerminalSessions(async () => { spawns++; return new FakePty() })
    const starts = Array.from({ length: MAX_TERMINALS }, () =>
      sessions.create(owner, () => directory, () => {}, () => {}))
    await assert.rejects(sessions.create(owner, () => directory, () => {}, () => {}), /最多同时打开/)
    const cancelled = Promise.all(starts.map((start) => assert.rejects(start, /已取消/)))
    sessions.closeOwner({ windowId: 1 })
    resolve('cwd')
    await cancelled
    assert.equal(spawns, 0)
    await sessions.create(owner, async () => 'cwd', () => {}, () => {})
    sessions.closeOwner({})
    assert.equal(spawns, 1)
  })

  it('原生启动过程中关闭会回收迟到的进程，启动错误也归还名额', async () => {
    const pty = new FakePty()
    let spawned!: (pty: FakePty) => void
    const native = new Promise<FakePty>((resolve) => { spawned = resolve })
    const sessions = new TerminalSessions(() => native)
    const starting = sessions.create(owner, async () => 'cwd', () => {}, () => {})
    await Promise.resolve()
    sessions.closeOwner({ windowId: 1 })
    spawned(pty)
    await assert.rejects(starting, /已取消/)
    assert.equal(pty.kills, 1)
    assert.equal(pty.listeners, 0)
    const failing = new TerminalSessions(async () => { throw new Error('shell 不存在') })
    for (let index = 0; index <= MAX_TERMINALS; index++) {
      await assert.rejects(failing.create(owner, async () => 'cwd', () => {}, () => {}), /shell 不存在/)
    }
  })

  it('草稿物化后按持久会话清理；其它会话和窗口的终端保持独立', async () => {
    const ptys: FakePty[] = []
    const sessions = new TerminalSessions(async () => {
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    })
    await sessions.create(owner, async () => 'cwd', () => {}, () => {})
    await sessions.create({ ...owner, windowId: 2, runtimeId: 'other', sessionId: 'session-b' }, async () => 'cwd', () => {}, () => {})
    sessions.bindSession('draft', 'session-a')
    sessions.closeOwner({ sessionId: 'session-a' })
    assert.equal(ptys[0]!.kills, 1)
    assert.equal(ptys[1]!.kills, 0)
    sessions.closeOwner({ windowId: 2 })
    assert.equal(ptys[1]!.kills, 1)
  })

  it('显示端就绪前的退出不会丢失，输出投递失败则释放资源', async () => {
    const pty = new FakePty()
    const events: TerminalEvent[] = []
    const sessions = new TerminalSessions(async () => pty)
    const terminal = await sessions.create(owner, async () => 'cwd', (event) => events.push(event), () => {})
    pty.finish(1)
    assert.deepEqual(events, [])
    sessions.control(1, { terminalId: terminal.id, type: 'ready' })
    assert.deepEqual(events, [{ terminalId: terminal.id, type: 'exit', exitCode: 1 }])
    sessions.closeOwner({})
    const broken = new FakePty()
    const failed = new TerminalSessions(async () => broken)
    await failed.create(owner, async () => 'cwd', () => { throw new Error('窗口已退出') }, () => {})
    broken.output('data')
    assert.equal(broken.kills, 1)
    assert.equal(broken.listeners, 0)
  })
})
