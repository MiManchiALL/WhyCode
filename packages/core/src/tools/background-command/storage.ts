import {
  appendFile,
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
import { resolve } from 'node:path'
import {
  persistedCommandTaskSchema,
  type PersistedCommandTask,
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
          result.push(parsed)
        }
      }
    }
    return result
  }

  async prepare(task: Pick<PersistedCommandTask, 'sessionId' | 'id'>): Promise<void> {
    await mkdir(this.sessionDir(task.sessionId), { recursive: true })
    await writeFile(this.outputPath(task), '', { flag: 'wx' })
  }

  appendOutput(task: Pick<PersistedCommandTask, 'sessionId' | 'id'>, chunk: Buffer): Promise<void> {
    return appendFile(this.outputPath(task), chunk)
  }

  async readOutput(
    task: Pick<PersistedCommandTask, 'sessionId' | 'id'>,
    offset: number,
    maxBytes: number,
  ): Promise<{ output: string; offset: number; nextOffset: number }> {
    const path = this.outputPath(task)
    const size = (await stat(path).catch(() => null))?.size ?? 0
    const safeOffset = Math.min(offset, size)
    const length = Math.min(maxBytes, size - safeOffset)
    if (length === 0) return { output: '', offset: safeOffset, nextOffset: safeOffset }

    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, safeOffset)
      return {
        output: buffer.subarray(0, bytesRead).toString('utf-8'),
        offset: safeOffset,
        nextOffset: safeOffset + bytesRead,
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
