import { randomUUID, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Client, SFTPWrapper } from 'ssh2'
import type { WorkspaceIO } from '@whycode/core'
import type { RemoteProcessHost } from '../ssh/process.ts'
import { quoteShell } from '../ssh/provision.ts'
import { ordinaryDirectory } from '../ssh/config-files.ts'
import { waitDependencyProcess } from './process.ts'
import { ENVIRONMENT_OWNER } from '../ssh/component.ts'

export async function environmentRoot(io: WorkspaceIO, root: string): Promise<void> {
  await ordinaryDirectory(io, root, true)
  const owner = posix.join(root, '.owner')
  let existing: string | null = null
  try {
    const metadata = await io.fs.lstat(owner)
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128) throw new Error('远端 Office 环境归属文件无效')
    existing = await io.fs.readFile(owner, 'utf8')
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (existing === null) {
    if ((await io.fs.readdir(root, { withFileTypes: true })).length) throw new Error('远端 Office 环境目录已被占用')
    await io.fs.writeFile(owner, ENVIRONMENT_OWNER, { flag: 'wx', mode: 0o600 })
  } else if (existing !== ENVIRONMENT_OWNER) throw new Error('远端 Office 环境归属校验失败')
}

export async function installRemoteDependencies(host: { client: Client; io: WorkspaceIO; home: string; processes: RemoteProcessHost },
  root: string, destination: string, key: string, archive: string, signal: AbortSignal, progress: (message: string) => void): Promise<void> {
  await environmentRoot(host.io, root)
  const staging = posix.join(root, `.install-${randomUUID()}`)
  await host.io.fs.mkdir(staging, { mode: 0o700 })
  const uploaded = posix.join(staging, 'environment.tgz')
  const run = (executable: string, args: string[]) => waitDependencyProcess(host.processes.spawn(
    posix.isAbsolute(executable) ? { executable, args } : [executable, ...args].map(quoteShell).join(' '), staging), signal)
  try {
    progress('正在上传 Office 运行环境；脚本、文档和素材仍在服务器执行')
    const expected = await uploadArchive(host.client, archive, uploaded, signal, progress)
    const actual = (await run('sha256sum', ['--', uploaded])).trim().split(/\s+/)[0]
    if (actual !== expected) throw new Error('远端 Office 环境传输校验失败')
    await run('tar', ['-xzf', uploaded, '-C', staging])
    // 本机打包的 Linux 依赖使用相同的 WASM 引擎；Node 仍须采用服务器架构。
    await run('mkdir', ['--', posix.join(staging, 'node')])
    await run('tar', ['-xf', posix.join(staging, 'node.tar.xz'), '-C', posix.join(staging, 'node'), '--strip-components=1'])
    await run(posix.join(staging, 'node/bin/node'), [posix.join(staging, 'office.mjs'), 'capabilities'])
    await host.io.fs.unlink(uploaded)
    await host.io.fs.unlink(posix.join(staging, 'node.tar.xz'))
    await host.io.fs.writeFile(posix.join(staging, '.ready'), key, { mode: 0o600 })
    signal.throwIfAborted()
    await host.io.fs.rename(staging, destination)
    progress('服务器 Office 运行环境已就绪')
  } finally {
    // 目录在受管根下由本次随机生成；失败时只清理自己的安装目录。
    const cleanup = host.processes.spawn(`rm -rf -- ${quoteShell(staging)}`, root)
    await waitDependencyProcess(cleanup, AbortSignal.timeout(30000)).catch(() => undefined)
  }
}

async function uploadArchive(client: Client, local: string, remote: string, signal: AbortSignal, progress: (message: string) => void): Promise<string> {
  const size = (await stat(local)).size
  if (size > 600 * 1024 * 1024) throw new Error('Office 环境超过传输大小上限')
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    client.sftp((error, channel) => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) { channel?.end(); reject(signal.reason) }
      else if (error) reject(error)
      else resolve(channel)
    })
    if (signal.aborted) abort()
  })
  const input = createReadStream(local)
  const output = sftp.createWriteStream(remote, { flags: 'wx', mode: 0o600 })
  const hash = createHash('sha256')
  let sent = 0, previous = 0
  input.on('data', chunk => { hash.update(chunk); sent += Buffer.byteLength(chunk)
    if (sent - previous >= 8 * 1024 * 1024) { progress(`Office 环境已传输 ${Math.round(sent / size * 100)}%`); previous = sent }
  })
  try { await pipeline(input, output, { signal }); return hash.digest('hex') } finally { sftp.end() }
}
