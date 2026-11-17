import type { WorkspaceFileSystem, WorkspaceIO } from '@whycode/core'

export const FILE_CONCURRENCY = 8

/** Keep independent file requests in flight, and settle every worker before releasing the transport. */
export async function mapFileOperations<T, R>(items: readonly T[], work: (item: T) => Promise<R>, concurrency = FILE_CONCURRENCY): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  let failure: { error: unknown } | undefined
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && cursor < items.length) {
      const index = cursor++
      try { results[index] = await work(items[index]!) } catch (error) { failure ??= { error } }
    }
  }))
  if (failure) throw failure.error
  return results
}

export async function exists(fs: WorkspaceFileSystem, file: string) {
  try { return await fs.lstat(file) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

/** 每一层都拒绝链接；删除和发布不能借助用户目录中的链接越界。 */
export async function ordinaryDirectory(io: WorkspaceIO, root: string, create = false): Promise<boolean> {
  const parent = io.path.dirname(root)
  if (parent !== root && !await ordinaryDirectory(io, parent, create)) return false
  let info = await exists(io.fs, root)
  if (!info && create) {
    try { await io.fs.mkdir(root, { mode: 0o700 }) }
    catch (error) { if (!await exists(io.fs, root)) throw error }
    info = await exists(io.fs, root)
  }
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`远端配置目录不是普通目录：${root}`)
  return true
}

export async function pruneEmptyParents(io: WorkspaceIO, directory: string, stop: string): Promise<void> {
  if (!io.path.relative(stop, directory) || io.path.relative(stop, directory).startsWith('..')) return
  for (let current = directory; current !== stop; current = io.path.dirname(current)) {
    if (!await ordinaryDirectory(io, current)) continue
    if ((await io.fs.readdir(current, { withFileTypes: true })).length > 0) break
    try { await io.fs.rmdir(current) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if ((await io.fs.readdir(current, { withFileTypes: true })).length > 0) break
      throw error
    }
  }
}
