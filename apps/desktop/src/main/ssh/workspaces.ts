import { posix } from 'node:path'
import { localWorkspaceIO, validateSessionId, type WorkspaceBinding } from '@whycode/core'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import type { SessionScratchPaths } from '../session-scratch.ts'
import type { DesktopSessionRuntime } from '../desktop-session-runtime.ts'
import { SshConnections } from './connections.ts'
import { SshConnectionMissingError } from './store.ts'
import type { TerminalPty } from '../terminal-sessions.ts'

export class SshWorkspaces {
  readonly connections: SshConnections
  constructor(connections: SshConnections) { this.connections = connections }
  async select(id: string, directory: string): Promise<WorkspaceBinding> {
    const connected = await this.connections.connect(id)
    if (connected.status !== 'connected') throw new Error('请先在连接设置中确认服务器指纹')
    const { path } = await this.connections.directory(id, directory)
    const connection = await this.connections.store.get(id)
    return { mode: 'ssh', connectionId: id, target: this.connections.host(id).target, label: connection.connection.name, workingDirectory: path }
  }
  io(workspace: RuntimeWorkspace) {
    return workspace.mode === 'ssh' ? this.connections.io(workspace.connectionId, workspace.target) : localWorkspaceIO
  }
  async prepare(runtime: DesktopSessionRuntime): Promise<{ home: string; scratch: SessionScratchPaths } | null> {
    const workspace = runtime.workspace
    if (workspace.mode !== 'ssh') return null
    const result = await this.connections.connect(workspace.connectionId)
    if (result.status !== 'connected') throw new Error('请先在连接设置中确认服务器指纹')
    const host = this.connections.host(workspace.connectionId, workspace.target)
    runtime.workspaceIO = this.io(workspace)
    const scratch = scratchPaths(host.home, runtime.sessionId ?? runtime.runtimeId)
    for (const directory of [posix.dirname(scratch.rootDirectory), scratch.rootDirectory, scratch.mainDirectory, scratch.subagentsDirectory]) {
      await host.io.fs.mkdir(directory, { recursive: true })
      if (await host.io.fs.realpath(directory) !== directory) throw new Error('远端临时目录不能经过符号链接')
    }
    runtime.workspaceScratch = scratch
    return { home: host.home, scratch }
  }
  async removeScratch(sessionId: string, workspace: WorkspaceBinding | undefined): Promise<string | void> {
    validateSessionId(sessionId)
    if (workspace?.mode !== 'ssh') return
    return this.connections.withFiles(workspace.connectionId, async (fs, home) => {
      const { rootDirectory } = scratchPaths(home, sessionId)
      const parent = posix.dirname(rootDirectory)
      const canonical = await fs.realpath(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (canonical === null) return
      if (canonical !== parent) throw new Error('远端临时目录不能经过符号链接，已保留文件')
      await fs.rm(rootDirectory, { recursive: true, force: true })
    }, workspace.target).catch((error: unknown) => {
      if (error instanceof SshConnectionMissingError) return 'SSH 连接已删除，服务器上的会话临时文件已保留'
      throw error
    })
  }
  async terminal(runtime: DesktopSessionRuntime, cwd: string): Promise<TerminalPty> {
    await this.prepare(runtime)
    const workspace = runtime.workspace
    if (workspace.mode !== 'ssh') throw new Error('不是 SSH 工作区')
    const process = this.connections.host(workspace.connectionId, workspace.target).processes.spawn('exec "${SHELL:-/bin/sh}" -l', cwd, { cols: 80, rows: 24 })
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

function scratchPaths(home: string, sessionId: string): SessionScratchPaths {
  validateSessionId(sessionId)
  const rootDirectory = posix.join(home, '.cache', 'whycode-scratch', sessionId)
  return { rootDirectory, mainDirectory: posix.join(rootDirectory, 'Main'), subagentsDirectory: posix.join(rootDirectory, 'subagents') }
}
