import * as fs from 'node:fs/promises'
import { constants, type Stats } from 'node:fs'
import { posix, resolve, relative, sep } from 'node:path'
import type { Attributes, SFTPWrapper } from 'ssh2'

/** An isolated SFTP peer: every request is confined to the disposable test directory. */
export function serveTestSftp(sftp: SFTPWrapper, root: string, remoteRoot: string): void {
  // ssh2's test server has no extension-advertising API; publish the extension this peer implements.
  const wire = sftp as unknown as { outgoing: { id: number }; _protocol: { channelData: (id: number, data: Buffer) => void } }
  const send = wire._protocol.channelData.bind(wire._protocol)
  wire._protocol.channelData = (id, data) => {
    if (id === wire.outgoing.id && data.length === 9 && data[4] === 2) {
      const name = Buffer.from('posix-rename@openssh.com')
      const extended = Buffer.alloc(data.length + name.length + 9)
      data.copy(extended); extended.writeUInt32BE(extended.length - 4, 0)
      extended.writeUInt32BE(name.length, 9); name.copy(extended, 13)
      extended.writeUInt32BE(1, 13 + name.length); extended[17 + name.length] = 49
      send(id, extended)
    } else send(id, data)
  }
  const handles = new Map<string, fs.FileHandle | string>()
  let next = 0
  const local = (value: string) => {
    const target = posix.resolve(remoteRoot, value)
    const suffix = posix.relative(remoteRoot, target)
    if (suffix === '..' || suffix.startsWith('../') || posix.isAbsolute(suffix)) throw new Error('outside fixture')
    return resolve(root, suffix)
  }
  const attrs = (stat: Stats): Attributes => ({
    mode: stat.mode, size: stat.size, uid: 0, gid: 0,
    atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000),
  })
  const handle = (value: fs.FileHandle | string) => {
    const id = String(++next); handles.set(id, value); return Buffer.from(id)
  }
  const file = (id: Buffer) => {
    const value = handles.get(id.toString())
    if (!value || typeof value === 'string') throw new Error('invalid handle')
    return value
  }
  const on = (event: string, action: (id: number, ...args: any[]) => Promise<void>) => {
    sftp.on(event, (id: number, ...args: any[]) => {
      void action(id, ...args).catch((error: NodeJS.ErrnoException) => {
        sftp.status(id, error.code === 'ENOENT' ? 2 : error.code === 'EACCES' ? 3 : 4, error.message)
      })
    })
  }
  on('REALPATH', async (id, value) => {
    const target = await fs.realpath(local(value))
    const suffix = relative(root, target)
    if (suffix.startsWith(`..${sep}`) || suffix === '..') throw new Error('outside fixture')
    sftp.name(id, [{ filename: posix.join(remoteRoot, suffix.replaceAll('\\', '/')), longname: '', attrs: attrs(await fs.stat(target)) }])
  })
  on('STAT', async (id, value) => { sftp.attrs(id, attrs(await fs.stat(local(value)))) })
  on('LSTAT', async (id, value) => { sftp.attrs(id, attrs(await fs.lstat(local(value)))) })
  on('FSTAT', async (id, value) => { sftp.attrs(id, attrs(await file(value).stat())) })
  on('SETSTAT', async (id, value, settings) => { if (settings.mode) await fs.chmod(local(value), settings.mode); sftp.status(id, 0) })
  on('FSETSTAT', async (id, value, settings) => { if (settings.mode) await file(value).chmod(settings.mode); sftp.status(id, 0) })
  on('OPEN', async (id, value, flags, settings) => {
    let mode = flags & 2 ? flags & 1 ? constants.O_RDWR : constants.O_WRONLY : constants.O_RDONLY
    if (flags & 4) mode |= constants.O_APPEND
    if (flags & 8) mode |= constants.O_CREAT
    if (flags & 16) mode |= constants.O_TRUNC
    if (flags & 32) mode |= constants.O_EXCL
    sftp.handle(id, handle(await fs.open(local(value), mode, settings.mode)))
  })
  on('READ', async (id, value, offset, length) => {
    const buffer = Buffer.alloc(Math.min(length, 64 * 1024))
    const { bytesRead } = await file(value).read(buffer, 0, buffer.length, offset)
    if (bytesRead) sftp.data(id, buffer.subarray(0, bytesRead)); else sftp.status(id, 1)
  })
  on('WRITE', async (id, value, offset, buffer) => { await file(value).write(buffer, 0, buffer.length, offset); sftp.status(id, 0) })
  on('CLOSE', async (id, value: Buffer) => {
    const entry = handles.get(value.toString()); handles.delete(value.toString())
    if (entry && typeof entry !== 'string') await entry.close()
    sftp.status(id, 0)
  })
  on('OPENDIR', async (id, value) => { const target = local(value); await fs.access(target); sftp.handle(id, handle(target)) })
  on('READDIR', async (id, value: Buffer) => {
    const target = handles.get(value.toString())
    if (typeof target !== 'string') { sftp.status(id, 1); return }
    handles.delete(value.toString())
    const entries = await fs.readdir(target)
    const names = await Promise.all(entries.map(async name => ({ filename: name, longname: '', attrs: attrs(await fs.lstat(resolve(target, name))) })))
    if (names.length) sftp.name(id, names); else sftp.status(id, 1)
  })
  on('MKDIR', async (id, value, settings) => { await fs.mkdir(local(value), { mode: settings.mode }); sftp.status(id, 0) })
  on('REMOVE', async (id, value) => { await fs.unlink(local(value)); sftp.status(id, 0) })
  on('RMDIR', async (id, value) => { await fs.rmdir(local(value)); sftp.status(id, 0) })
  on('RENAME', async (id, from, to) => { await fs.rename(local(from), local(to)); sftp.status(id, 0) })
  on('EXTENDED', async (id, name, data: Buffer) => {
    if (name !== 'posix-rename@openssh.com') { sftp.status(id, 8); return }
    const length = data.readUInt32BE(0)
    const from = data.subarray(4, 4 + length).toString()
    const to = data.subarray(8 + length).toString()
    await fs.rename(local(from), local(to)); sftp.status(id, 0)
  })
  sftp.once('close', () => { for (const value of handles.values()) if (typeof value !== 'string') void value.close(); handles.clear() })
}
