import { constants } from 'node:fs'
import { posix } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { SFTPWrapper } from 'ssh2'
import { isUnknownWorkspaceOutcome, unknownWorkspaceOutcome, type WorkspaceFileSystem } from '@whycode/core'

/** Map SFTP status to filesystem errors consumed by the existing file/checkpoint tools. */
function fileError(error: Error & { code?: number | string }): Error {
  if (error.code === 6 || error.code === 7 || error.code === 'ECONNRESET' || /connection|channel|no response|closed/i.test(error.message)) return unknownWorkspaceOutcome('SSH 文件连接中断')
  const codes: Record<number, string> = { 2: 'ENOENT', 3: 'EACCES', 6: 'ENOTCONN', 7: 'ENOTCONN', 11: 'EEXIST', 18: 'ENOTEMPTY' }
  return Object.assign(new Error(error.message), { code: typeof error.code === 'number' ? codes[error.code] ?? 'EIO' : error.code })
}
export function createSftpFileSystem(sftp: SFTPWrapper): WorkspaceFileSystem {
  const call = <T>(operation: (callback: (error: Error | undefined | null, result: T) => void) => void): Promise<T> => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { reject(unknownWorkspaceOutcome('SSH 文件请求超时')); sftp.end() }, 30_000)
    try { operation((error, result) => { clearTimeout(timeout); error ? reject(fileError(error)) : resolve(result) }) }
    catch (error) { clearTimeout(timeout); reject(fileError(error as Error)) }
  })
  const io: WorkspaceFileSystem = {
    stat: path => call(done => sftp.stat(path, done)),
    lstat: path => call(done => sftp.lstat(path, done)),
    realpath: path => call(done => sftp.realpath(path, done)),
    readFile: ((path: string, encoding?: 'utf8') => call<Buffer>(done => sftp.readFile(path, done)).then(buffer => encoding ? buffer.toString(encoding) : buffer)) as WorkspaceFileSystem['readFile'],
    writeFile: async (path, data, options) => {
      const settings = typeof options === 'object' ? options : {}
      await call<void>(done => sftp.writeFile(path, typeof data === 'string' ? data : Buffer.from(data), { mode: settings.mode, flag: settings.flag ?? 'w' }, done))
    },
    open: async path => {
      const handle = await call<Buffer>(done => sftp.open(path, 'r', done))
      return {
        stat: () => call(done => sftp.fstat(handle, done)),
        read: async (buffer, offset, length, position) => ({ bytesRead: await call<number>(done => sftp.read(handle, buffer, offset, length, position, done)) }),
        close: () => call<void>(done => sftp.close(handle, done)),
      }
    },
    createReadStream: (path, options) => {
      const stream = sftp.createReadStream(path, options)
      const abort = () => stream.destroy(new Error('读取已取消'))
      options?.signal?.addEventListener('abort', abort, { once: true })
      stream.once('close', () => options?.signal?.removeEventListener('abort', abort))
      if (options?.signal?.aborted) abort()
      return stream
    },
    readdir: async path => (await call<import('ssh2').FileEntry[]>(done => sftp.readdir(path, done))).map(entry => ({
      name: entry.filename, size: entry.attrs.size, mode: entry.attrs.mode,
      isFile: () => (entry.attrs.mode & 0o170000) === 0o100000,
      isDirectory: () => (entry.attrs.mode & 0o170000) === 0o040000,
      isSymbolicLink: () => (entry.attrs.mode & 0o170000) === 0o120000,
    })),
    mkdir: async (path, options) => {
      if (path === '/' && options?.recursive) return
      try { await call<void>(done => sftp.mkdir(path, { mode: options?.mode ?? 0o700 }, done)) }
      catch (error) {
        if (!options?.recursive || isUnknownWorkspaceOutcome(error)) throw error
        const existing = await io.stat(path).catch((failure: NodeJS.ErrnoException) => { if (failure.code === 'ENOENT') return null; throw failure })
        if (existing?.isDirectory()) return
        if (existing) throw error
        await io.mkdir(posix.dirname(path), { recursive: true })
        await call<void>(done => sftp.mkdir(path, { mode: 0o700 }, done))
      }
    },
    unlink: path => call<void>(done => sftp.unlink(path, done)),
    rmdir: async path => {
      try { await call<void>(done => sftp.rmdir(path, done)) }
      catch (error) {
        // SFTP v3 uses generic FAILURE for nonempty directories; preserve Node's rmdir contract.
        if ((error as NodeJS.ErrnoException).code === 'EIO' && (await io.readdir(path, { withFileTypes: true })).length) {
          throw Object.assign(new Error('目录非空'), { code: 'ENOTEMPTY' })
        }
        throw error
      }
    },
    rm: async (path, options) => {
      try {
        const stats = await io.lstat(path)
        if (stats.isDirectory()) {
          if (!options.recursive) throw new Error('不能将目录当作文件删除')
          for (const entry of await io.readdir(path, { withFileTypes: true })) {
            if (entry.name === '.' || entry.name === '..') continue
            await io.rm(posix.join(path, entry.name), options)
          }
          await io.rmdir(path)
        } else await io.unlink(path)
      } catch (error) { if (!options.force || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    },
    rename: (from, to) => call<void>(done => sftp.ext_openssh_rename(from, to, done)),
    copyFile: async (from, to, mode) => {
      await pipeline(sftp.createReadStream(from), sftp.createWriteStream(to, { flags: mode === constants.COPYFILE_EXCL ? 'wx' : 'w' })).catch(error => { throw fileError(error) })
    },
    chmod: (path, mode) => call<void>(done => sftp.chmod(path, mode & 0o777, done)),
  }
  return io
}

/** Publish a binary or complete file only after upload finishes; failed uploads leave no partial destination. */
export async function atomicSftpWrite(fs: WorkspaceFileSystem, path: string, data: Uint8Array, mode: number): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, data, { flag: 'wx', mode })
    await fs.rename(temporary, path)
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
}
