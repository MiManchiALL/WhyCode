import { posix } from 'node:path'
import { localWorkspaceIO, validateSessionId, type WorkspaceBinding } from '@whycode/core'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import type { SessionScratchPaths } from '../session-scratch.ts'
import type { DesktopSessionRuntime } from '../desktop-session-runtime.ts'
import { SshConnections } from './connections.ts'
import { SshConnectionMissingError } from './store.ts'
import type { TerminalPty } from '../terminal-sessions.ts'
import { copyDirectorySnapshot } from '../directory-snapshot.ts'

export class SshWorkspaces {
  readonly connections: SshConnections
  constructor(connections: SshConnections) { this.connections = connections }
  async select(target: string, directory: string): Promise<Extract<WorkspaceBinding, { mode: 'ssh' }>> {
    const id = await this.connections.connectionIdForTarget(target)
    const connected = await this.connections.resume(id)
    if (connected.status !== 'connected') throw new Error('请先在连接设置中确认服务器指纹')
    const { path } = await this.connections.directory(id, directory)
    const connection = await this.connections.store.get(id)
    return { mode: 'ssh', target: this.connections.host(id, target).target, label: connection.connection.name, workingDirectory: path }
  }
  io(workspace: RuntimeWorkspace) {
    return workspace.mode === 'ssh' ? this.connections.io(workspace.target) : localWorkspaceIO
  }
  async connect(workspace: RuntimeWorkspace) {
    if (workspace.mode !== 'ssh') return null
    const id = await this.connections.connectionIdForTarget(workspace.target)
    const result = await this.connections.resume(id)
    if (result.status !== 'connected') throw new Error('请先在连接设置中确认服务器指纹')
    const host = this.connections.host(id, workspace.target)
    if (!(await host.io.fs.stat(workspace.workingDirectory)).isDirectory()) throw new Error('远端工作目录不存在或不是文件夹')
    return host
  }
  async prepare(runtime: DesktopSessionRuntime): Promise<{ home: string; scratch: SessionScratchPaths } | null> {
    const host = await this.connect(runtime.workspace)
    if (!host) return null
    runtime.workspaceIO = this.io(runtime.workspace)
    const scratch = await ensureScratch(host, runtime.sessionId ?? runtime.runtimeId)
    runtime.workspaceScratch = scratch
    return { home: host.home, scratch }
  }
  async snapshot(workspace: WorkspaceBinding, sourceId: string, targetId: string): Promise<void> {
    const host = await this.connect(workspace)
    if (!host) throw new Error('不是 SSH 工作区')
    const source = await ensureScratch(host, sourceId)
    const target = sshScratchPaths(host.home, targetId)
    await host.io.fs.mkdir(target.rootDirectory)
    try {
      await copyDirectorySnapshot(source.rootDirectory, target.rootDirectory, host.io)
    } catch (error) {
      await host.io.fs.rm(target.rootDirectory, { recursive: true, force: true }).catch(cleanup => {
        throw new AggregateError([error, cleanup], '创建远端临时目录快照失败且未能完整清理')
      })
      throw error
    }
  }
  async removeScratch(sessionId: string, workspace: WorkspaceBinding | undefined): Promise<string | void> {
    validateSessionId(sessionId)
    if (workspace?.mode !== 'ssh') return
    return this.connections.connectionIdForTarget(workspace.target).then(id => this.connections.withFiles(id, async (fs, home) => {
      const { rootDirectory } = sshScratchPaths(home, sessionId)
      const parent = posix.dirname(rootDirectory)
      const canonical = await fs.realpath(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (canonical === null) return
      if (canonical !== parent) throw new Error('远端临时目录不能经过符号链接，已保留文件')
      await fs.rm(rootDirectory, { recursive: true, force: true })
      await fs.rmdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
      })
    }, workspace.target)).catch((error: unknown) => {
      if (error instanceof SshConnectionMissingError) return 'SSH 连接已删除，服务器上的会话临时文件已保留'
      throw error
    })
  }
  async terminal(runtime: DesktopSessionRuntime, cwd: string): Promise<TerminalPty> {
    await this.prepare(runtime)
    const workspace = runtime.workspace
    if (workspace.mode !== 'ssh') throw new Error('不是 SSH 工作区')
    const process = this.connections.targetHost(workspace.target).processes.spawn('exec "${SHELL:-/bin/sh}" -l', cwd, { cols: 80, rows: 24 })
    process.on('error', () => {})
    let cols = 80
    let rows = 24
    const pty: TerminalPty = {
      get cols() { return cols }, get rows() { return rows },
      write: value => { process.stdin.write(value) },
      resize: (nextCols, nextRows) => { cols = nextCols; rows = nextRows; void process.resize(cols, rows).catch(() => {}) },
      pause: () => { process.stdout.pause() }, resume: () => { process.stdout.resume() },
      kill: () => { void process.terminate() },
      onData: callback => { process.stdout.setEncoding('utf8'); process.stdout.on('data', callback); return { dispose: () => { process.stdout.off('data', callback) } } },
      onExit: callback => {
        const listener = (code: number | null) => callback({ exitCode: code ?? 1 })
        process.on('close', listener)
        if (process.closed) queueMicrotask(() => listener(process.exitCode))
        return { dispose: () => { process.off('close', listener) } }
      },
    }
    return pty
  }
}

export function sshScratchPaths(home: string, sessionId: string): SessionScratchPaths {
  validateSessionId(sessionId)
  const rootDirectory = posix.join(home, '.cache', 'whycode-scratch', sessionId)
  return { rootDirectory, mainDirectory: posix.join(rootDirectory, 'Main'), subagentsDirectory: posix.join(rootDirectory, 'subagents') }
}

async function ensureScratch(host: NonNullable<Awaited<ReturnType<SshWorkspaces['connect']>>>, sessionId: string) {
  const scratch = sshScratchPaths(host.home, sessionId)
  for (const directory of [posix.dirname(scratch.rootDirectory), scratch.rootDirectory, scratch.mainDirectory, scratch.subagentsDirectory]) {
    await host.io.fs.mkdir(directory, { recursive: true })
    if (await host.io.fs.realpath(directory) !== directory) throw new Error('远端临时目录不能经过符号链接')
  }
  return scratch
}
