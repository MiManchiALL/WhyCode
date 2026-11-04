import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIAGNOSTIC_LIMITS } from '../../shared/diagnostics.ts'
import { MAX_RECORD_BYTES } from './format.ts'

export interface DiagnosticPolicy {
  runtimeFileBytes: number; runtimeFiles: number; retentionDays: number
  reportBytes: number; reports: number
}
export interface DiagnosticFile { name: string; bytes: number; created: number; kind: 'runtime' | 'fault' }
const OWNED_NAME = /^(runtime|fault)-(\d{13})-[a-f0-9-]{36}\.(jsonl|json)$/

function identify(name: string, bytes: number): DiagnosticFile | null {
  const match = OWNED_NAME.exec(name)
  if (!match || (match[1] === 'runtime' ? match[3] !== 'jsonl' : match[3] !== 'json')) return null
  return { name, bytes, created: Number(match[2]), kind: match[1] as DiagnosticFile['kind'] }
}

export class DiagnosticFiles {
  readonly directory: string
  readonly policy: DiagnosticPolicy
  private current: DiagnosticFile | undefined
  private lastTimestamp = 0

  constructor(directory: string, policy: DiagnosticPolicy = DIAGNOSTIC_LIMITS) {
    this.directory = directory; this.policy = policy
  }

  async list(): Promise<DiagnosticFile[]> {
    const entries = await readdir(this.directory, { withFileTypes: true })
    const files: DiagnosticFile[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !OWNED_NAME.test(entry.name)) continue
      const file = identify(entry.name, (await stat(join(this.directory, entry.name))).size)
      if (file) files.push(file)
    }
    return files.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name))
  }

  async initialize(now: number): Promise<number> {
    await mkdir(this.directory, { recursive: true })
    await this.prune(now)
    const files = await this.list()
    this.lastTimestamp = files.at(-1)?.created ?? 0
    this.current = files.filter(file => file.kind === 'runtime').at(-1)
    if (!this.current?.bytes) return 0
    // 磁盘写满或进程退出可能留下半条 JSONL；只修剪最后一条，避免续写粘连新旧记录。
    const handle = await open(join(this.directory, this.current.name), 'r+')
    try {
      const tail = Buffer.alloc(Math.min(this.current.bytes, MAX_RECORD_BYTES))
      const offset = this.current.bytes - tail.length
      await handle.read(tail, 0, tail.length, offset)
      if (tail.at(-1) === 10) return 0
      const end = offset + tail.lastIndexOf(10) + 1
      const removed = this.current.bytes - end
      await handle.truncate(end)
      this.current.bytes = end
      return removed
    } finally { await handle.close() }
  }

  private name(kind: 'runtime' | 'fault', now: number): string {
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1)
    return `${kind}-${this.lastTimestamp}-${randomUUID()}.${kind === 'runtime' ? 'jsonl' : 'json'}`
  }

  private obsolete(files: DiagnosticFile[], now: number, reserve?: 'runtime' | 'fault'): DiagnosticFile[] {
    const remove = new Set<DiagnosticFile>()
    for (const kind of ['runtime', 'fault'] as const) {
      const cap = kind === 'runtime' ? this.policy.runtimeFileBytes : this.policy.reportBytes
      const count = (kind === 'runtime' ? this.policy.runtimeFiles : this.policy.reports) - (reserve === kind ? 1 : 0)
      const kept = files.filter(file => {
        if (file.kind !== kind) return false
        if (file.bytes > cap || (kind === 'runtime' && file.created <= now - this.policy.retentionDays * 86_400_000)) {
          remove.add(file); return false
        }
        return true
      })
      kept.slice(0, Math.max(0, kept.length - count)).forEach(file => remove.add(file))
    }
    return [...remove]
  }

  async prune(now: number, reserve?: 'runtime' | 'fault'): Promise<void> {
    for (const file of this.obsolete(await this.list(), now, reserve)) {
      await unlink(join(this.directory, file.name))
      if (this.current?.name === file.name) this.current = undefined
    }
  }

  async append(line: string, now: number): Promise<void> {
    const bytes = Buffer.byteLength(line)
    if (bytes > this.policy.runtimeFileBytes) throw new Error('诊断记录超过单文件容量')
    if (!this.current || this.current.bytes + bytes > this.policy.runtimeFileBytes
      || this.current.created <= now - this.policy.retentionDays * 86_400_000) {
      await this.prune(now, 'runtime')
      this.current = { name: this.name('runtime', now), bytes: 0, created: now, kind: 'runtime' }
    }
    // 部分写入失败后停止使用该文件，重读实际大小再决定能否续写。
    const current = this.current
    this.current = undefined
    await appendFile(join(this.directory, current.name), line)
    current.bytes += bytes
    this.current = current
  }

  /** 低频且至多 1 MiB。删除与创建同步完成，退出监测和常规故障共用同一个容量闸门。 */
  report(body: string, now: number): void {
    if (Buffer.byteLength(body) > this.policy.reportBytes) throw new Error('故障报告超过容量上限')
    mkdirSync(this.directory, { recursive: true })
    const files = readdirSync(this.directory, { withFileTypes: true }).flatMap(entry => {
      if (!entry.isFile() || !OWNED_NAME.test(entry.name)) return []
      const file = identify(entry.name, statSync(join(this.directory, entry.name)).size)
      return file ? [file] : []
    }).sort((a, b) => a.created - b.created || a.name.localeCompare(b.name))
    for (const file of this.obsolete(files, now, 'fault').filter(file => file.kind === 'fault')) {
      unlinkSync(join(this.directory, file.name))
    }
    this.lastTimestamp = Math.max(this.lastTimestamp, files.at(-1)?.created ?? 0)
    writeFileSync(join(this.directory, this.name('fault', now)), body, { flag: 'wx' })
  }

  async clear(): Promise<void> {
    this.current = undefined
    const files = await this.list()
    const results = await Promise.allSettled(files.map(file => unlink(join(this.directory, file.name))))
    const failed = results.filter(result => result.status === 'rejected')
    if (failed.length) {
      const cause: unknown = failed[0]!.reason
      throw new Error(`有 ${failed.length} 个诊断文件未能清除：${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
  }
}
