import { posix } from 'node:path'
import { localWorkspaceIO, validateSessionId, type WorkspaceBinding } from '@whycode/core'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import type { SessionScratchPaths } from '../session-scratch.ts'
import type { DesktopSessionRuntime } from '../desktop-session-runtime.ts'
import { SshConnections } from './connections.ts'
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
    validateSessionId(runtime.sessionId ?? runtime.runtimeId)
    const rootDirectory = posix.join(host.home, '.cache', 'whycode-scratch', runtime.sessionId ?? runtime.runtimeId)
    const scratch = { rootDirectory, mainDirectory: posix.join(rootDirectory, 'Main'), subagentsDirectory: posix.join(rootDirectory, 'subagents') }
    for (const directory of [posix.dirname(rootDirectory), rootDirectory, scratch.mainDirectory, scratch.subagentsDirectory]) {
      await host.io.fs.mkdir(directory, { recursive: true })
      if ((await host.io.fs.lstat(directory)).isSymbolicLink()) throw new Error('远端临时目录不能是符号链接')
    }
    runtime.workspaceScratch = scratch
    return { home: host.home, scratch }
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
