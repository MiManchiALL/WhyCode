import { randomUUID } from 'node:crypto'
import type { DiagnosticState } from '../../shared/diagnostics.ts'
import { DiagnosticFiles, type DiagnosticPolicy } from './files.ts'
import { diagnosticFingerprint, diagnosticText, formatDiagnostic, formatFault, MAX_RECORD_BYTES, type DiagnosticEvent } from './format.ts'
import { exportDiagnostics } from './export.ts'

const QUEUE_BYTES = 1024 * 1024
const RECENT_BYTES = 768 * 1024
const REPEAT_WINDOW_MS = 60_000
type Entry = { kind: 'runtime' | 'fault'; body: string; time: number; bytes: number }
  | { kind: 'operation'; run: () => Promise<void> }
interface Repetition { first: number; last: number; count: number; source: string; event: string }

export class DiagnosticStore {
  readonly files: DiagnosticFiles
  readonly runId = randomUUID()
  readonly ready: Promise<void>
  onChanged?: (state: DiagnosticState) => void
  private readonly now: () => number
  private readonly environment: string
  private queue: Entry[] = []
  private queuedBytes = 0
  private recent: string[] = []
  private recentBytes = 0
  private repetitions = new Map<string, Repetition>()
  private worker: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private maintenanceDue = false
  private reportedDrops = 0
  private closed = false
  private state: DiagnosticState = { runtimeBytes: 0, reportBytes: 0, reportCount: 0, busy: null, error: null, droppedRecords: 0 }

  constructor(options: { directory: string; environment: Record<string, unknown>; now?: () => number; policy?: DiagnosticPolicy }) {
    this.files = new DiagnosticFiles(options.directory, options.policy)
    this.now = options.now ?? Date.now
    this.environment = formatDiagnostic({ level: 'info', source: 'app', event: 'environment', details: options.environment }, this.now(), this.runId).trimEnd()
    this.ready = this.files.initialize(this.now()).then(removed => {
      if (removed) this.log({ level: 'warn', source: 'diagnostics', event: 'incomplete-record-discarded', details: { bytes: removed } })
      return this.refresh()
    }, error => this.failed(error))
  }

  start(): void {
    const body = this.environment + '\n'
    this.remember(body)
    this.enqueue({ kind: 'runtime', body, time: this.now(), bytes: Buffer.byteLength(body) })
    this.timer = setInterval(() => {
      this.flushRepetitions()
      this.maintenanceDue = true
      this.ensureWorker()
    }, 60_000)
    this.timer.unref()
  }

  log(event: DiagnosticEvent): void { this.record(event, false) }
  fault(event: DiagnosticEvent): void { this.record(event, true) }

  private record(event: DiagnosticEvent, fault: boolean): void {
    if (this.closed) return
    const time = this.now()
    const line = formatDiagnostic(event, time, this.runId)
    if (event.level !== 'info') {
      const key = diagnosticFingerprint(line)
      const previous = this.repetitions.get(key)
      if (previous && time - previous.first < REPEAT_WINDOW_MS) {
        previous.count++; previous.last = time
        return
      }
      if (previous) this.summarize(key, previous)
      if (this.repetitions.size >= 64) {
        const oldest = this.repetitions.entries().next().value
        if (oldest) this.summarize(...oldest)
      }
      this.repetitions.set(key, { first: time, last: time, count: 0, source: event.source, event: event.event })
    }
    this.remember(line)
    this.enqueue({ kind: 'runtime', body: line, time, bytes: Buffer.byteLength(line) })
    if (fault) {
      const body = formatFault(line, this.environment, this.recent, this.files.policy.reportBytes, this.state.droppedRecords)
      this.enqueue({ kind: 'fault', body, time, bytes: Buffer.byteLength(body) })
    }
  }

  /** uncaughtExceptionMonitor 不改变 Node 的退出语义，也不依赖尚未执行的 Promise。 */
  fatal(event: DiagnosticEvent): void {
    const line = formatDiagnostic(event, this.now(), this.runId)
    try { this.files.report(formatFault(line, this.environment, this.recent, this.files.policy.reportBytes, this.state.droppedRecords), this.now()) }
    catch (error) { this.failed(error) }
  }

  private remember(line: string): void {
    this.recent.push(line); this.recentBytes += Buffer.byteLength(line)
    while (this.recentBytes > RECENT_BYTES) this.recentBytes -= Buffer.byteLength(this.recent.shift()!)
  }

  private summarize(key: string, repetition: Repetition): void {
    this.repetitions.delete(key)
    if (!repetition.count) return
    const line = formatDiagnostic({ level: 'warn', source: 'diagnostics', event: 'repeated-events', details: {
      fingerprint: key, source: repetition.source, event: repetition.event,
      additionalCount: repetition.count, first: repetition.first, last: repetition.last,
    } }, this.now(), this.runId)
    this.remember(line)
    this.enqueue({ kind: 'runtime', body: line, time: this.now(), bytes: Buffer.byteLength(line) })
  }

  private flushRepetitions(): void {
    for (const [key, repetition] of this.repetitions) this.summarize(key, repetition)
  }

  private enqueue(entry: Exclude<Entry, { kind: 'operation' }>): void {
    if (entry.kind === 'runtime' && this.state.error && this.state.busy !== 'clearing') { this.state.droppedRecords++; return }
    // 故障现场优先占用队列；淘汰数量进入状态和后续运行日志。
    while (entry.kind === 'fault' && this.queuedBytes + entry.bytes > QUEUE_BYTES) {
      const index = this.queue.findIndex(item => item.kind !== 'operation')
      if (index < 0) break
      const removed = this.queue.splice(index, 1)[0]!
      if (removed.kind !== 'operation') this.queuedBytes -= removed.bytes
      this.state.droppedRecords++
    }
    if (this.queuedBytes + entry.bytes > QUEUE_BYTES) { this.state.droppedRecords++; return }
    this.queue.push(entry); this.queuedBytes += entry.bytes
    this.ensureWorker()
  }

  private ensureWorker(): void {
    if (this.worker) return
    this.worker = this.drain().finally(() => {
      this.worker = undefined
      if (this.queue.length || this.maintenanceDue) this.ensureWorker()
    })
  }

  private async drain(): Promise<void> {
    await this.ready
    while (this.queue.length) {
      const item = this.queue.shift()!
      if (item.kind === 'operation') { await item.run(); continue }
      this.queuedBytes -= item.bytes
      if (item.kind === 'runtime' && this.state.error) { this.state.droppedRecords++; continue }
      try {
        if (item.kind === 'fault') this.files.report(item.body, item.time)
        else {
          const batch = [item.body]
          let bytes = item.bytes
          while (this.queue[0]?.kind === 'runtime' && bytes + this.queue[0].bytes <= Math.min(MAX_RECORD_BYTES, this.files.policy.runtimeFileBytes)) {
            const next = this.queue.shift()!
            if (next.kind !== 'runtime') break
            batch.push(next.body); bytes += next.bytes; this.queuedBytes -= next.bytes
          }
          await this.files.append(batch.join(''), item.time)
        }
      } catch (error) { this.failed(error) }
    }
    if (this.maintenanceDue) {
      this.maintenanceDue = false
      try { await this.files.prune(this.now()) } catch (error) { this.failed(error) }
    }
    if (!this.state.error && this.reportedDrops !== this.state.droppedRecords) {
      const count = this.state.droppedRecords
      const line = formatDiagnostic({ level: 'warn', source: 'diagnostics', event: 'dropped-records', details: { count } }, this.now(), this.runId)
      try { await this.files.append(line, this.now()); this.reportedDrops = count }
      catch (error) { this.failed(error) }
    }
    await this.refresh()
    this.onChanged?.({ ...this.state })
  }

  private failed(error: unknown): void {
    this.state.error = diagnosticText(error instanceof Error ? error.message : String(error), 2048)
    this.onChanged?.({ ...this.state })
  }

  private async refresh(): Promise<void> {
    try {
      const files = await this.files.list()
      this.state.runtimeBytes = files.filter(file => file.kind === 'runtime').reduce((sum, file) => sum + file.bytes, 0)
      const reports = files.filter(file => file.kind === 'fault')
      this.state.reportBytes = reports.reduce((sum, file) => sum + file.bytes, 0)
      this.state.reportCount = reports.length
    } catch (error) { this.failed(error) }
  }

  async getState(): Promise<DiagnosticState> {
    await this.ready
    return { ...this.state }
  }

  private operation(busy: 'clearing' | 'exporting', run: () => Promise<void>): Promise<void> {
    if (this.state.busy || this.closed) return Promise.reject(new Error('诊断日志正在处理，请稍后重试'))
    this.state.busy = busy
    this.onChanged?.({ ...this.state })
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ kind: 'operation', run: async () => {
        let failure: unknown
        try { await run() }
        catch (error) { failure = error }
        finally { await this.refresh(); this.state.busy = null; this.onChanged?.({ ...this.state }) }
        if (failure !== undefined) reject(failure)
        else resolve()
      } })
      this.ensureWorker()
    })
  }

  clear(): Promise<void> {
    if (this.state.busy || this.closed) return Promise.reject(new Error('诊断日志正在处理，请稍后重试'))
    this.queue = this.queue.filter(item => item.kind === 'operation'); this.queuedBytes = 0
    this.recent = []; this.recentBytes = 0; this.repetitions.clear()
    this.state.droppedRecords = 0; this.reportedDrops = 0
    return this.operation('clearing', async () => {
      try {
        await this.files.clear()
        this.state.error = null
      } catch (error) { this.failed(error); throw error }
    })
  }

  export(destination: string): Promise<void> {
    this.flushRepetitions()
    return this.operation('exporting', () => exportDiagnostics(this.files, destination))
  }

  async flush(): Promise<void> {
    this.flushRepetitions()
    while (this.worker) await this.worker
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.log({ level: 'info', source: 'app', event: 'shutdown', details: { droppedRecords: this.state.droppedRecords } })
    this.closed = true
    await this.flush()
  }
}
