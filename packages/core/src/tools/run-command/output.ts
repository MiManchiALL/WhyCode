import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { Writable, type Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { WorkspaceIO } from '../../workspace/io.ts'
import { COMMAND_PREVIEW_BYTES, COMMAND_PREVIEW_LINES } from './output-result.ts'

/** 有界尾部与延迟落盘借鉴 Pi OutputAccumulator；写入由 Node 流背压控制。 */
export class CommandOutput extends Writable {
  private readonly io: WorkspaceIO
  private readonly scratchDirectory: string | undefined
  private readonly onProgress: ((text: string) => void) | undefined
  private prefix: Buffer[] = []
  private tail = Buffer.alloc(0)
  private tailStartsAtLineBoundary = true
  private completedLines = 0
  private hasOpenLine = false
  private file: Writable | undefined
  private fileDone: Promise<void> | undefined
  private readonly fileClosed = new AbortController()
  private filePath: string | undefined
  private pendingWrite: Promise<void> = Promise.resolve()
  totalBytes = 0

  constructor(io: WorkspaceIO, scratchDirectory: string | undefined, onProgress?: (text: string) => void) {
    super()
    this.io = io
    this.scratchDirectory = scratchDirectory
    this.onProgress = onProgress
  }

  get totalLines(): number { return this.completedLines + Number(this.hasOpenLine) }
  get truncated(): boolean { return this.totalBytes > COMMAND_PREVIEW_BYTES || this.totalLines > COMMAND_PREVIEW_LINES }
  get fullOutputPath(): string | undefined { return this.writableFinished && !this.errored ? this.filePath : undefined }

  preview(): string {
    let start = this.tailStartsAtLineBoundary ? 0 : this.tail.indexOf(10) + 1
    if (!this.tailStartsAtLineBoundary && start === 0) return ''
    let lines = 0
    for (let index = this.tail.length - 1; index >= start; index--) {
      if (this.tail[index] === 10 && index < this.tail.length - 1 && ++lines === COMMAND_PREVIEW_LINES) {
        start = index + 1
        break
      }
    }
    return this.tail.subarray(start).toString('utf8')
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.pendingWrite = this.append(chunk)
    this.pendingWrite.then(() => callback(), callback)
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.file?.end()
    if (this.fileDone) this.fileDone.then(() => callback(), callback)
    else callback()
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.file?.destroy(error ?? undefined)
    this.prefix = []
    // _destroy 可以与 mkdir / 写入同时发生；清理必须等在途操作收束。
    void Promise.allSettled([this.pendingWrite, this.fileDone]).then(results => {
      const failed = results.find(result => result.status === 'rejected')
      callback(error ?? (failed?.status === 'rejected' ? failed.reason : null))
    })
  }

  private async append(chunk: Buffer): Promise<void> {
    if (chunk.length === 0) return
    this.totalBytes += chunk.length
    for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, at + 1)) this.completedLines++
    this.hasOpenLine = chunk.at(-1) !== 10
    const tail = Buffer.concat([this.tail, chunk])
    let start = Math.max(0, tail.length - COMMAND_PREVIEW_BYTES)
    // UTF-8 续字节不能成为预览起点；半行只留在有界缓冲，最终展示时整行跳过。
    while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++
    if (start > 0) this.tailStartsAtLineBoundary = tail[start - 1] === 10
    this.tail = Buffer.from(tail.subarray(start))
    this.onProgress?.(chunk.toString('utf8'))
    if (this.truncated && !this.file) await this.openLog()
    if (this.file) await this.writeLog(chunk)
    else this.prefix.push(chunk)
  }

  private async openLog(): Promise<void> {
    if (!this.scratchDirectory) throw new Error('当前会话没有临时工作目录，无法保存完整命令输出')
    const { fs, path } = this.io
    const root = await fs.lstat(this.scratchDirectory)
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('命令日志的会话临时目录不是普通目录')
    const directory = path.join(this.scratchDirectory, 'command-output')
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('命令日志目录不是普通目录')
    // 取消/流错误可能发生在异步目录准备期间，不得在清理后迟到创建文件。
    if (this.destroyed) throw this.errored ?? new Error('命令输出已关闭')
    this.filePath = path.join(directory, `${randomUUID()}.log`)
    this.file = fs.createWriteStream(this.filePath, { flags: 'wx', mode: 0o600 })
    this.fileDone = finished(this.file, { cleanup: true })
    void this.fileDone.then(
      () => this.fileClosed.abort(),
      error => { this.destroy(error); this.fileClosed.abort(error) },
    )
    for (const chunk of this.prefix) await this.writeLog(chunk)
    this.prefix = []
  }

  private async writeLog(chunk: Buffer): Promise<void> {
    // close 不保证伴随 error/drain（例如 SFTP 断线），不能留下永远等待的写入。
    if (!this.file!.write(chunk)) await once(this.file!, 'drain', { signal: this.fileClosed.signal })
  }
}

/** 两路独立解码后合流；读端暂停会沿本地管道或 SSH ACK 窗口传回生产端。 */
export async function captureCommandOutput(streams: readonly Readable[], output: Writable): Promise<void> {
  const outputDone = finished(output, { cleanup: true })
  const readers = streams.map(stream => finished(stream, { cleanup: true }))
  void outputDone.catch(() => { for (const stream of streams) stream.destroy() })
  void Promise.all(readers).then(() => output.end(), error => output.destroy(error))
  for (const stream of streams) stream.setEncoding('utf8').pipe(output, { end: false })
  const results = await Promise.allSettled([outputDone, ...readers])
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
}
