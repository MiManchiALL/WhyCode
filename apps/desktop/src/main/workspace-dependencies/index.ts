import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { localWorkspaceIO, type ToolContext, type WorkspaceIO } from '@whycode/core'
import type { SshConnections } from '../ssh/connections.ts'
import { localNode, nodeArchive, NODE_VERSION } from './node.ts'
import { runDependencyProcess, waitDependencyProcess } from './process.ts'
import { environmentRoot, installRemoteDependencies } from './remote.ts'

const FILES = ['package.json', 'package-lock.json', 'run.mjs', 'office.mjs', 'check.mjs']
export interface DependencyPaths { node: string; run: string; office: string; check: string; libraries: string[] }

/** Installs only when explicitly invoked; ordinary SSH reconnects never prepare Office dependencies. */
export class WorkspaceDependencies {
  private readonly pending = new Map<string, Promise<unknown>>()
  private readonly resources: string
  private readonly cache: string
  private readonly connections: SshConnections
  constructor(resources: string, cache: string, connections: SshConnections) { this.resources = resources; this.cache = cache; this.connections = connections }

  async load(ctx: ToolContext): Promise<DependencyPaths> {
    const io = ctx.workspaceIO ?? localWorkspaceIO
    const signal = AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(15 * 60 * 1000)])
    return this.exclusive(io.identity, signal, async () => {
      const version = (await readFile(join(this.resources, 'source.sha256'), 'utf8')).trim()
      if (!/^[a-f0-9]{64}$/.test(version)) throw new Error('工作区环境资源校验信息无效')
      const progress = ctx.onProgress ?? (() => {})
      if (io.identity === 'local') {
        const environment = await this.prepare(process.platform, process.arch, version, signal, progress)
        return dependencyPaths(environment.directory, environment.node, io)
      }
      const id = await this.connections.connectionIdForTarget(io.identity)
      return this.connections.withSkillFiles(id, async () => {
        const host = this.connections.host(id)
        const architecture = (await waitDependencyProcess(host.processes.spawn('uname -m', host.home), signal)).trim()
        const arch = architecture === 'x86_64' ? 'x64' : architecture === 'aarch64' || architecture === 'arm64' ? 'arm64' : null
        if (!arch) throw new Error(`Office 运行环境不支持此服务器架构：${architecture}`)
        const root = posix.join(host.component.directory, 'office')
        await environmentRoot(host.io, root)
        const key = `${NODE_VERSION}-${version}-${arch}`
        const destination = posix.join(root, key)
        const ready = await readReady(host.io, destination, key)
        if (!ready) {
          const environment = await this.prepare('linux', arch, version, signal, progress)
          const archive = await this.exclusive(`archive:${environment.directory}`, signal, () => this.pack(environment.directory, signal))
          await installRemoteDependencies(host, root, destination, key, archive, signal, progress)
        }
        return dependencyPaths(destination, posix.join(destination, 'node/bin/node'), io)
      })
    })
  }

  private prepare(platform: string, arch: string, version: string, signal: AbortSignal, progress: (message: string) => void) {
    return this.exclusive(`package:${platform}:${arch}`, signal, async () => {
      const key = `${NODE_VERSION}-${version}-${platform}-${arch}`
      const directory = join(this.cache, key)
      const node = await this.exclusive('node', signal, () => localNode(join(this.cache, 'downloads'), signal, progress))
      if (await readReady(localWorkspaceIO, directory, key)) return { directory, node: node.executable }
      const staging = `${directory}.${randomUUID()}.tmp`
      await mkdir(staging, { recursive: true })
      try {
        for (const file of FILES) await copyFile(join(this.resources, file), join(staging, file))
        progress(`正在准备 Office 依赖（${platform}/${arch}），首次安装可能需要几分钟`)
        await runDependencyProcess(node.executable, [node.npm, 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
          `--os=${platform}`, `--cpu=${arch}`, '--registry=https://registry.npmjs.org', `--cache=${join(this.cache, 'npm-cache')}`,
        ], staging, signal, progress)
        if (platform === 'linux') {
          await copyFile(await nodeArchive(join(this.cache, 'downloads'), platform, arch, signal, progress), join(staging, 'node.tar.xz'))
        }
        if (platform === process.platform && arch === process.arch) {
          await runDependencyProcess(node.executable, [join(staging, 'office.mjs'), 'capabilities'], staging, signal)
        }
        signal.throwIfAborted()
        await writeFile(join(staging, '.ready'), key, { flag: 'wx' })
        await rename(staging, directory)
        return { directory, node: node.executable }
      } finally { await rm(staging, { recursive: true, force: true }) }
    })
  }

  private async pack(directory: string, signal: AbortSignal): Promise<string> {
    const archive = `${directory}.tgz`
    try { if ((await stat(archive)).isFile()) return archive } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temporary = `${archive}.${randomUUID()}.tmp`
    try {
      await runDependencyProcess('tar', ['-czf', temporary, '-C', directory, '.'], this.cache, signal)
      await rename(temporary, archive)
      return archive
    } finally { await rm(temporary, { force: true }) }
  }

  private async exclusive<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    while (this.pending.has(key)) {
      const current = this.pending.get(key)!
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        current.catch(() => undefined).finally(() => { signal.removeEventListener('abort', abort); resolve() })
        if (signal.aborted) abort()
      })
    }
    signal.throwIfAborted()
    const task = work()
    this.pending.set(key, task)
    try { return await task } finally { this.pending.delete(key) }
  }
}

export async function readReady(io: WorkspaceIO, directory: string, key: string): Promise<boolean> {
  const metadata = await io.fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!metadata) return false
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('工作区依赖目录不是普通目录')
  try {
    for (const file of ['.ready', ...FILES]) {
      const entry = await io.fs.lstat(io.path.join(directory, file))
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('工作区依赖文件不是普通文件')
      if (file === '.ready' && entry.size > 256) throw new Error('工作区依赖版本记录无效')
    }
    if (await io.fs.readFile(io.path.join(directory, '.ready'), 'utf8') !== key) throw new Error('工作区依赖版本校验失败，请清理运行环境后重试')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`工作区依赖目录不完整，请清理后重新准备：${directory}`)
    throw error
  }
}

function dependencyPaths(root: string, node: string, io: WorkspaceIO): DependencyPaths {
  return { node, run: io.path.join(root, 'run.mjs'), office: io.path.join(root, 'office.mjs'), check: io.path.join(root, 'check.mjs'),
    libraries: ['docx', 'pptxgenjs', 'exceljs', 'jszip', 'fast-xml-parser'] }
}
