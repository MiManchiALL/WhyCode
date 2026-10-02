import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Client, ClientChannel } from 'ssh2'
import type { WorkspaceFileSystem } from '@whycode/core'
import { atomicSftpWrite } from './sftp.ts'
import type { RemoteComponent } from './component.ts'

export const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`
export const digest = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')

export function execChannel(client: Client, command: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => client.exec(command, (error, channel) => error ? reject(error) : resolve(channel)))
}

/** 大型受管环境在服务器删除，避免逐文件 SFTP 往返；调用方先验证归属。 */
export async function removeRemoteEnvironment(client: Client, directory: string): Promise<void> {
  if (!posix.isAbsolute(directory) || !directory.endsWith('/.cache/whycode-remote/office') || posix.normalize(directory) !== directory) throw new Error('远端环境清理路径无效')
  const channel = await execChannel(client, `rm -rf -- ${quoteShell(directory)}`)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { channel.close(); reject(new Error('远端运行环境清理超时，可重试清理')) }, 120_000)
    channel.resume(); channel.stderr.resume()
    channel.once('error', (error: Error) => { clearTimeout(timer); reject(error) })
    channel.once('close', (code: number) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('远端运行环境清理失败')) })
  })
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

export async function provisionRemote(client: Client, fs: WorkspaceFileSystem, component: RemoteComponent, resourceDirectory: string): Promise<{ executable: string; ripgrep: string }> {
  const arch = await architecture(client)
  const { directory } = component
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
  return { executable, ripgrep }
}
