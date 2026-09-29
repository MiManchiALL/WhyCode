import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { PassThrough, Writable } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { z } from 'zod'
import { unknownWorkspaceOutcome, type WorkspaceProcess } from '@whycode/core'

const packetSchema = z.object({
  id: z.string().optional(), task: z.string().optional(),
  event: z.enum(['data', 'exit']).optional(), data: z.string().max(24 * 1024).optional(),
  stream: z.enum(['stdout', 'stderr']).optional(),
  code: z.number().int().optional(), error: z.string().optional(), version: z.number().int().optional(),
})
type Packet = z.infer<typeof packetSchema>
export class RemoteProcess extends EventEmitter implements WorkspaceProcess {
  readonly id = randomUUID()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin: Writable
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  closed = false
  private readonly rpc: RemoteProcessHost
  constructor(rpc: RemoteProcessHost) {
    super()
    this.rpc = rpc
    this.stdin = new Writable({
      write: (data: Buffer, _encoding, done) => { void rpc.request({ method: 'input', task: this.id, data: data.toString('base64') }).then(() => done(), done) },
      final: done => { void rpc.request({ method: 'input', task: this.id, end: true }).then(() => done(), done) },
    })
    this.stdin.on('error', () => {})
  }
  async terminate(): Promise<boolean> {
    if (this.closed) return true
    try { await this.rpc.request({ method: 'stop', task: this.id }); return true } catch { return false }
  }
  resize(cols: number, rows: number): Promise<Packet> { return this.rpc.request({ method: 'resize', task: this.id, cols, rows }) }
  finish(code: number | null, error?: Error): void {
    if (this.closed) return
    this.closed = true; this.exitCode = code
    this.stdout.end(); this.stderr.end(); this.stdin.destroy()
    if (error) this.emit('error', error)
    this.emit('close', code)
  }
}

/** One bounded RPC channel per connection; no request is retried after transport loss. */
export class RemoteProcessHost {
  private readonly pending = new Map<string, { resolve: (packet: Packet) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly processes = new Map<string, RemoteProcess>()
  private buffer = ''
  private closed = false
  private readonly heartbeat: ReturnType<typeof setInterval>
  private readonly channel: ClientChannel
  private readonly onFailure: () => void
  constructor(channel: ClientChannel, onFailure: () => void = () => {}) {
    this.channel = channel; this.onFailure = onFailure
    channel.setEncoding('utf8')
    channel.on('data', (data: string) => this.accept(data))
    channel.on('error', (error: Error) => this.fail(error))
    channel.on('close', () => this.fail(unknownWorkspaceOutcome('SSH 连接已断开')))
    channel.stderr.resume()
    this.heartbeat = setInterval(() => { void this.request({ method: 'ping' }).catch(error => this.fail(error)) }, 15_000)
    this.heartbeat.unref()
  }
  async ready(): Promise<void> {
    const reply = await this.request({ method: 'hello' })
    if (reply.version !== 2) { this.close(); throw new Error('远端组件版本不匹配') }
  }
  spawn(command: string | { executable: string; args: string[] }, cwd: string, terminal?: { cols: number; rows: number }): RemoteProcess {
    const process = new RemoteProcess(this)
    this.processes.set(process.id, process)
    void this.request({ method: 'start', task: process.id, ...(typeof command === 'string' ? { command } : command), cwd, pty: Boolean(terminal), ...terminal })
      .then(() => process.emit('spawn'), error => { this.processes.delete(process.id); process.finish(null, error) })
    return process
  }
  request(value: Record<string, unknown>): Promise<Packet> {
    if (this.closed) return Promise.reject(new Error('SSH 连接已断开'))
    if (this.pending.size >= 64) return Promise.reject(new Error('远端请求过多，请稍后重试'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(unknownWorkspaceOutcome('远端组件响应超时')), 12_000)
      this.pending.set(id, { resolve, reject, timer })
      this.channel.write(`${JSON.stringify({ ...value, id })}\n`, error => { if (error) this.fail(error) })
    })
  }
  close(): void { this.fail(unknownWorkspaceOutcome('SSH 连接已关闭'), false) }
  private accept(data: string): void {
    this.buffer += data
    if (this.buffer.length > 2 * 1024 * 1024) { this.fail(unknownWorkspaceOutcome('远端组件响应超过限制')); return }
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1)
      let packet: Packet
      try { packet = packetSchema.parse(JSON.parse(line)) } catch { this.fail(unknownWorkspaceOutcome('远端组件响应格式无效')); return }
      const pending = packet.id && this.pending.get(packet.id)
      if (pending) {
        this.pending.delete(packet.id!); clearTimeout(pending.timer)
        packet.error ? pending.reject(new Error(packet.error)) : pending.resolve(packet)
      }
      const process = packet.task && this.processes.get(packet.task)
      if (!process) continue
      if (packet.event === 'data' && typeof packet.data === 'string') {
        const output = packet.stream === 'stderr' ? process.stderr : process.stdout
        output.write(Buffer.from(packet.data, 'base64'), () => {
          if (!this.closed) this.channel.write(`${JSON.stringify({ id: randomUUID(), method: 'ack', task: process.id })}\n`)
        })
      }
      if (packet.event === 'exit') { this.processes.delete(process.id); process.finish(packet.code ?? null) }
    }
  }
  private fail(error: Error, notify = true): void {
    if (this.closed) return
    this.closed = true; clearInterval(this.heartbeat)
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error) }
    this.pending.clear()
    for (const process of this.processes.values()) process.finish(null, error)
    this.processes.clear(); this.channel.close()
    if (notify) this.onFailure()
  }
}
