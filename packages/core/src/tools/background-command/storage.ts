import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { Writable } from 'node:stream'
import { resolve } from 'node:path'
import {
  persistedCommandTaskSchema,
  type PersistedCommandTask,
  type CommandOutputChunk,
} from './types.ts'

/** 后台命令的小型磁盘层：manifest 原子更新、日志追加与会话级清理集中在这里。 */
export class CommandTaskStorage {
  private readonly root: string

  constructor(root: string) {
    this.root = root
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  async loadAll(): Promise<PersistedCommandTask[]> {
    const result: PersistedCommandTask[] = []
    const sessionDirs = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      const dir = resolve(this.root, sessionDir.name)
      const files = await readdir(dir).catch(() => [])
      for (const file of files.filter((name) => name.endsWith('.json'))) {
        const parsed = await this.readManifest(resolve(dir, file))
        if (
          parsed &&
          file === `${parsed.id}.json` &&
          this.sessionDir(parsed.sessionId) === dir
        ) {
          // 活动任务的 manifest 不逐块重写；崩溃恢复以实际落盘长度恢复读取游标。
          const size = await stat(this.outputPath(parsed)).then(info => info.size, () => parsed.outputBytes)
          result.push({ ...parsed, outputBytes: size })
        }
      }
    }
    return result
  }

  async createOutput(
    task: Pick<PersistedCommandTask, 'sessionId' | 'id'>,
    onWrite: (bytes: number) => void,
  ): Promise<Writable> {
    await mkdir(this.sessionDir(task.sessionId), { recursive: true })
    const handle = await open(this.outputPath(task), 'wx', 0o600)
    return new Writable({
      // writeFile 结算后才交付游标与 drain；pipe 的背压限制待写队列。
      write(chunk: Buffer, _encoding, callback) {
        void handle.writeFile(chunk).then(() => {
          onWrite(chunk.length)
          callback()
        }, callback)
      },
      destroy(error, callback) {
        void handle.close().then(() => callback(error), callback)
      },
    })
  }

  async readOutput(
    task: Pick<PersistedCommandTask, 'sessionId' | 'id' | 'outputBytes'>,
    offset: number,
    maxBytes: number,
  ): Promise<Omit<CommandOutputChunk, 'task'>> {
    const path = this.outputPath(task)
    const size = Math.min((await stat(path)).size, task.outputBytes)
    const safeOffset = Math.min(offset, size)
    if (safeOffset === size) return { output: '', offset: size, nextOffset: size, hasMore: false, partialLine: false }

    const handle = await open(path, 'r')
    try {
      // 任意 offset 也不能从 UTF-8 字符中间解码；最多向前对齐三个字节。
      const position = Math.max(0, safeOffset - 3)
      const buffer = Buffer.alloc(Math.min(size - position, maxBytes + 6))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      let start = safeOffset - position
      while (start > 0 && (buffer[start]! & 0xc0) === 0x80) start--
      let end = Math.min(bytesRead, start + maxBytes)
      while (end < bytesRead && (buffer[end]! & 0xc0) === 0x80) end--
      // 优先完整行；超长单行仍可按字符边界前进，不跳过任何已保存的内容。
      if (position + end < size) {
        const newline = buffer.lastIndexOf(0x0a, end - 1)
        if (newline >= start) end = newline + 1
      }
      const nextOffset = position + end
      return {
        output: buffer.subarray(start, end).toString('utf-8'),
        offset: position + start,
        nextOffset,
        hasMore: nextOffset < size,
        partialLine: (position + start > 0 && buffer[start - 1] !== 0x0a)
          || (nextOffset < size && buffer[end - 1] !== 0x0a),
      }
    } finally {
      await handle.close()
    }
  }

  async persist(task: PersistedCommandTask): Promise<void> {
    const data = JSON.stringify(persistedCommandTaskSchema.parse(task), null, 2)
    const target = this.manifestPath(task)
    const temporary = `${target}.${crypto.randomUUID()}.tmp`
    await writeFile(temporary, data)
    try {
      await rename(temporary, target)
    } catch (error) {
      if (!isWindowsReplaceError(error)) throw error
      // Windows 的 rename 不能稳定覆盖现有文件；copyFile 可替换目标，临时文件仍确保内容先完整落盘。
      await copyFile(temporary, target)
      await rm(temporary, { force: true })
    }
  }

  async removeTask(task: Pick<PersistedCommandTask, 'sessionId' | 'id'>): Promise<void> {
    await Promise.all([
      rm(this.manifestPath(task), { force: true }),
      rm(this.outputPath(task), { force: true }),
    ])
  }

  async removeSession(sessionId: string): Promise<void> {
    await rm(this.sessionDir(sessionId), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    })
  }

  private async readManifest(path: string): Promise<PersistedCommandTask | null> {
    try {
      const parsed = persistedCommandTaskSchema.safeParse(JSON.parse(await readFile(path, 'utf-8')))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  private sessionDir(sessionId: string): string {
    return resolve(this.root, sessionId.replace(/[^a-zA-Z0-9_-]/g, '-'))
  }

  private manifestPath(task: Pick<PersistedCommandTask, 'sessionId' | 'id'>): string {
    return resolve(this.sessionDir(task.sessionId), `${task.id}.json`)
  }

  private outputPath(task: Pick<PersistedCommandTask, 'sessionId' | 'id'>): string {
    return resolve(this.sessionDir(task.sessionId), `${task.id}.log`)
  }
}

function isWindowsReplaceError(error: unknown): boolean {
  if (process.platform !== 'win32' || !(error instanceof Error)) return false
  return 'code' in error && (error.code === 'EPERM' || error.code === 'EEXIST')
}
