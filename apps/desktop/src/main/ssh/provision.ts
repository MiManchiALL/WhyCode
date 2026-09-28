import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Client, ClientChannel } from 'ssh2'
import type { WorkspaceFileSystem } from '@whycode/core'
import { atomicSftpWrite } from './sftp.ts'

const OWNER = 'WhyCode remote process host v1\n'
export const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
export const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

export function execChannel(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => client.exec(command, (error, channel) => error ? reject(error) : resolve(channel)))
}

async function architecture(client: Client): Promise<'x64' | 'arm64'> {
  const channel = await execChannel(client, 'uname -s; uname -m')
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { channel.close(); reject(new Error('远端环境检测超时')) }, 10_000)
    channel.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 1024) channel.close() })
    channel.stderr.resume()
    channel.on('error', (error: Error) => { clearTimeout(timer); reject(error) })
    channel.on('close', (code: number) => {
      clearTimeout(timer)
      const [os, arch] = output.trim().split(/\s+/u)
      if (code !== 0 || os !== 'Linux' || !['x86_64', 'aarch64', 'arm64'].includes(arch ?? '')) reject(new Error('目前支持 Linux x64 / ARM64 服务器'))
      else resolve(arch === 'x86_64' ? 'x64' : 'arm64')
    })
  })
}

export async function provisionRemote(client: Client, fs: WorkspaceFileSystem, home: string, resourceDirectory: string): Promise<{ executable: string; directory: string }> {
  const arch = await architecture(client)
  const binary = await readFile(join(resourceDirectory, `whycode-remote-linux-${arch}`))
  const directory = posix.join(home, '.cache', 'whycode-remote')
  await fs.mkdir(directory, { recursive: true })
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('远端组件目录不能是符号链接')
  const ownerPath = posix.join(directory, '.owner')
  const ownerInfo = await fs.lstat(ownerPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (ownerInfo && !ownerInfo.isFile()) throw new Error('远端组件归属文件不是普通文件')
  let owner = await fs.readFile(ownerPath, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (owner === null) {
    if ((await fs.readdir(directory, { withFileTypes: true })).length) throw new Error('远端缓存目录已被占用')
    await fs.writeFile(ownerPath, OWNER, { flag: 'wx', mode: 0o600 }); owner = OWNER
  }
  if (owner !== OWNER) throw new Error('远端组件目录归属校验失败')
  const hash = digest(binary)
  const executable = posix.join(directory, `host-${hash}`)
  const executableInfo = await fs.lstat(executable).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (executableInfo && !executableInfo.isFile()) throw new Error('远端组件不是普通文件')
  const installed = await fs.readFile(executable).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (installed && digest(installed) !== hash) throw new Error('远端组件校验失败，请清理后重新连接')
  if (!installed) {
    await atomicSftpWrite(fs, executable, binary, 0o700)
    if (digest(await fs.readFile(executable)) !== hash) throw new Error('远端组件上传校验失败')
  }
  return { executable, directory }
}

/** Only known component files are removed; unknown contents, projects and scratch are untouched. */
export async function cleanupRemoteComponent(fs: WorkspaceFileSystem, directory: string): Promise<void> {
  const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('远端组件目录归属校验失败')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (entries.some(entry => !entry.isFile() || (entry.name !== '.owner' && !/^host-[0-9a-f]{64}$/u.test(entry.name)))) throw new Error('组件目录包含未知文件，已保留目录')
  const owner = posix.join(directory, '.owner')
  if (await fs.readFile(owner, 'utf8') !== OWNER) throw new Error('远端组件目录归属校验失败')
  for (const entry of entries) if (entry.name !== '.owner') await fs.unlink(posix.join(directory, entry.name))
  await fs.unlink(owner)
  await fs.rmdir(directory)
}
