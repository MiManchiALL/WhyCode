import { watch, type FSWatcher, type Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

interface DirectoryWatch {
  watcher: FSWatcher
  files: Map<string, string | null> | null
  timer?: ReturnType<typeof setTimeout>
}

/** 按真实读取的文件监听；目录事件本身不代表正在预览的正文发生变化。 */
export class WorkspaceFileWatch {
  private readonly directories = new Map<string, DirectoryWatch>()
  private closed = false
  private readonly changed: () => void
  constructor(changed: () => void) { this.changed = changed }

  directory(path: string): void { this.observe(path, null) }

  file(path: string, info: Stats): void {
    // 一份文档只监听有界的静态依赖，其余资源仍可手动刷新。
    const count = [...this.directories.values()].reduce((sum, entry) => sum + (entry.files?.size ?? 0), 0)
    if (count >= 128) return
    const entry = this.observe(dirname(path), new Map())
    const key = pathKey(path)
    if (entry?.files && !entry.files.has(key)) entry.files.set(key, version(info))
  }

  reset(): void {
    for (const entry of this.directories.values()) {
      clearTimeout(entry.timer)
      entry.watcher.close()
    }
    this.directories.clear()
  }

  close(): void { this.closed = true; this.reset() }

  private observe(path: string, files: DirectoryWatch['files']): DirectoryWatch | undefined {
    if (this.closed) return
    const existing = this.directories.get(path)
    if (existing) return existing
    try {
      const watcher = watch(path, { persistent: false }, (_event, filename) => {
        if (this.directories.get(path) !== entry) return
        if (entry.files && filename && !entry.files.has(pathKey(resolve(path, filename)))) return
        clearTimeout(entry.timer)
        entry.timer = setTimeout(() => void this.check(path, entry), 150)
      })
      const entry: DirectoryWatch = { watcher, files }
      this.directories.set(path, entry)
      watcher.on('error', () => {
        watcher.close()
        clearTimeout(entry.timer)
        if (this.directories.get(path) === entry) this.directories.delete(path)
      })
      return entry
    } catch { /* 目录尚未创建或已移除时，由手动刷新重新建立监听。 */ }
  }

  private async check(path: string, entry: DirectoryWatch): Promise<void> {
    if (this.directories.get(path) !== entry) return
    let changed = entry.files === null
    for (const [file, previous] of entry.files ?? []) {
      const current = await stat(file).then(version, () => null)
      if (current !== previous) { entry.files?.set(file, current); changed = true }
    }
    if (changed && this.directories.get(path) === entry) this.changed()
  }
}

function pathKey(path: string): string { return process.platform === 'win32' ? path.toLowerCase() : path }
function version(info: Stats): string { return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}` }
