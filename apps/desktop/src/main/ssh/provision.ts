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
  const [os, arch] = (await commandOutput(client, 'uname -s; uname -m')).trim().split(/\s+/u)
  if (os !== 'Linux' || !['x86_64', 'aarch64', 'arm64'].includes(arch ?? '')) throw new Error('目前支持 Linux x64 / ARM64 服务器')
  return arch === 'x86_64' ? 'x64' : 'arm64'
}

async function commandOutput(client: Client, command: string): Promise<string> {
  const channel = await execChannel(client, command)
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => { reject(new Error('远端环境检测超时')); channel.close() }, 10_000)
    channel.on('data', (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 1024) { clearTimeout(timer); reject(new Error('远端环境检测输出过长')); channel.close() }
    })
    channel.stderr.resume()
    channel.on('error', (error: Error) => { clearTimeout(timer); reject(error) })
    channel.on('close', (code: number) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error('远端组件检测失败，请确认服务器可执行 uname 和 sha256sum'))
      else resolve(output)
    })
  })
}

export async function provisionRemote(client: Client, fs: WorkspaceFileSystem, home: string, resourceDirectory: string): Promise<{ executable: string; ripgrep: string; directory: string }> {
  const arch = await architecture(client)
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
  const install = async (resource: string, prefix: string): Promise<string> => {
    const binary = await readFile(join(resourceDirectory, resource))
    const hash = digest(binary)
    const executable = posix.join(directory, `${prefix}-${hash}`)
    const executableInfo = await fs.lstat(executable).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (executableInfo && !executableInfo.isFile()) throw new Error('远端组件不是普通文件')
    if (!executableInfo) {
      await atomicSftpWrite(fs, executable, binary, 0o700)
    }
    // 校验留在服务器，避免每次重连都经 SFTP 下载完整组件并耗尽文件请求时限。
    const installedHash = (await commandOutput(client, `sha256sum -- ${quoteShell(executable)}`)).trim().split(/\s+/u)[0]
    if (installedHash !== hash) throw new Error('远端组件校验失败，请清理后重新连接')
    return executable
  }
  const executable = await install(`whycode-remote-linux-${arch}`, 'host')
  const ripgrep = await install(`ripgrep-linux-${arch}`, 'rg')
  return { executable, ripgrep, directory }
}

/** Only known component files are removed; unknown contents, projects and scratch are untouched. */
export async function cleanupRemoteComponent(fs: WorkspaceFileSystem, directory: string): Promise<void> {
  const info = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!info) return
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('远端组件目录归属校验失败')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  if (entries.some(entry => !entry.isFile() || (entry.name !== '.owner' && !/^(?:host|rg)-[0-9a-f]{64}$/u.test(entry.name)))) throw new Error('组件目录包含未知文件，已保留目录')
  const owner = posix.join(directory, '.owner')
  if (await fs.readFile(owner, 'utf8') !== OWNER) throw new Error('远端组件目录归属校验失败')
  for (const entry of entries) if (entry.name !== '.owner') await fs.unlink(posix.join(directory, entry.name))
  await fs.unlink(owner)
  await fs.rmdir(directory)
}
