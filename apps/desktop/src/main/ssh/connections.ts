import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Client } from 'ssh2'
import type { WorkspaceFileSystem, WorkspaceIO } from '@whycode/core'
import type { SshConnection, SshConnectResult, SshDirectory } from '../../shared/ssh.ts'
import { SshConnectionStore } from './store.ts'
import { createSftpFileSystem } from './sftp.ts'
import { cleanupRemoteComponent, execChannel, provisionRemote, quoteShell } from './provision.ts'
import { RemoteProcessHost } from './process.ts'

interface ConnectedHost {
  client: Client
  io: WorkspaceIO
  home: string
  target: string
  componentDirectory: string
  processes: RemoteProcessHost
}
interface AuthenticatedHost { client: Client; fs: WorkspaceFileSystem; home: string; target: string }

export class SshCredentialsRequiredError extends Error {}

export class SshConnections {
  private readonly connected = new Map<string, ConnectedHost>()
  private readonly connecting = new Map<string, { promise: Promise<SshConnectResult>; controller: AbortController }>()
  readonly store: SshConnectionStore
  private readonly resources: string
  constructor(store: SshConnectionStore, resources: string) { this.store = store; this.resources = resources }
  isConnected(id: string): boolean { return this.connected.has(id) }

  connect(id: string, fingerprint?: string, secret?: string): Promise<SshConnectResult> {
    const current = this.connected.get(id)
    if (current) return Promise.resolve({ status: 'connected', home: current.home })
    const pending = this.connecting.get(id)
    if (pending) return pending.promise
    const controller = new AbortController()
    const promise = this.open(id, controller.signal, fingerprint, secret).finally(() => {
      if (this.connecting.get(id)?.controller === controller) this.connecting.delete(id)
    })
    this.connecting.set(id, { promise, controller })
    return promise
  }
  private async authenticate(id: string, signal: AbortSignal, approved?: string, suppliedSecret?: string): Promise<AuthenticatedHost | Extract<SshConnectResult, { status: 'trust-required' }>> {
    const stored = await this.store.get(id)
    signal.throwIfAborted()
    const connection = stored.connection
    const secret = suppliedSecret ?? stored.secret
    if (connection.authentication === 'password' && !secret) {
      throw new SshCredentialsRequiredError('请输入 SSH 密码；未记住的密码在 WhyCode 退出后会被清除')
    }
    const expected = connection.fingerprint ?? approved
    let observed: string | undefined
    const client = new Client()
    client.on('error', () => {})
    const abort = () => client.destroy()
    signal.addEventListener('abort', abort, { once: true })
    client.once('close', () => signal.removeEventListener('abort', abort))
    try {
      const privateKey = connection.authentication === 'key' ? await readFile(connection.privateKeyPath!) : undefined
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve); client.once('error', reject)
        client.once('close', () => reject(new Error('SSH 连接已关闭')))
        client.connect({
          host: connection.host, port: connection.port, username: connection.username,
          readyTimeout: 20_000, keepaliveInterval: 15_000, keepaliveCountMax: 3,
          ...(connection.authentication === 'password' ? { password: secret } : {}),
          ...(privateKey ? { privateKey, passphrase: secret } : {}),
          ...(connection.authentication === 'agent' ? { agent: process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK } : {}),
          hostVerifier: (key: Buffer) => {
            observed = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
            return observed === expected
          },
        })
      })
      signal.throwIfAborted()
      // Persist trust only after successful authentication against the confirmed key.
      if (!connection.fingerprint) await this.store.trust(id, expected!)
      const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => client.sftp((error, value) => error ? reject(error) : resolve(value)))
      sftp.once('close', () => client.end())
      const fs = createSftpFileSystem(sftp)
      const home = await fs.realpath('.')
      signal.throwIfAborted()
      return { client, fs, home, target: targetIdentity(connection, expected!) }
    } catch (error) {
      client.end()
      signal.throwIfAborted()
      if (observed && !expected) return { status: 'trust-required', fingerprint: observed, host: `${connection.host}:${connection.port}` }
      if (observed && expected !== observed) throw new Error('服务器指纹与已保存的指纹不一致，已拒绝连接')
      if (error instanceof Error && 'level' in error && error.level === 'client-authentication') {
        if (connection.authentication === 'agent') throw new Error('系统 SSH Agent 身份验证失败，请检查已加载的密钥和服务器授权')
        throw new SshCredentialsRequiredError('SSH 身份验证失败，请检查用户名及密码或私钥；连接配置已保留')
      }
      if (connection.authentication === 'key' && error instanceof Error && /Cannot parse privateKey:.*(?:no passphrase|bad passphrase)/iu.test(error.message)) {
        throw new SshCredentialsRequiredError('请输入正确的私钥密码；连接配置已保留')
      }
      throw error
    }
  }
  private async open(id: string, signal: AbortSignal, approved?: string, suppliedSecret?: string): Promise<SshConnectResult> {
    const transport = await this.authenticate(id, signal, approved, suppliedSecret)
    if ('status' in transport) return transport
    const { client, fs, home, target } = transport
    try {
      const component = await provisionRemote(client, fs, home, this.resources)
      const processes = new RemoteProcessHost(await execChannel(client, `exec ${quoteShell(component.executable)}`), () => client.end())
      await processes.ready()
      signal.throwIfAborted()
      const io: WorkspaceIO = { identity: target, platform: 'linux', path: path.posix, fs, spawn: (command, cwd) => processes.spawn(command, cwd) }
      const host: ConnectedHost = { client, io, home, target, processes, componentDirectory: component.directory }
      this.connected.set(id, host)
      client.once('close', () => { if (this.connected.get(id) === host) this.connected.delete(id); processes.close() })
      return { status: 'connected', home }
    } catch (error) {
      client.end()
      signal.throwIfAborted()
      throw error
    }
  }
  host(id: string, target?: string): ConnectedHost {
    const host = this.connected.get(id)
    if (!host) throw new Error('SSH 未连接，请在连接设置中连接服务器')
    if (target && target !== host.target) throw new Error('此会话绑定的 SSH 服务器与当前连接不同')
    return host
  }
  /** Operations resolve the live channel each time, but never reconnect or replay automatically. */
  io(id: string, target: string): WorkspaceIO {
    const fs = new Proxy({} as WorkspaceIO['fs'], { get: (_value, key) => (...args: unknown[]) => {
      const files = this.host(id, target).io.fs
      const operation = files[key as keyof typeof files] as (...args: unknown[]) => unknown
      return operation.apply(files, args)
    } })
    return { identity: target, platform: 'linux', path: path.posix, fs, spawn: (command, cwd) => this.host(id, target).processes.spawn(command, cwd) }
  }
  async directory(id: string, value?: string): Promise<SshDirectory> {
    const host = this.host(id)
    const directory = await host.io.fs.realpath(value ? path.posix.resolve(host.home, value) : host.home)
    if (!(await host.io.fs.stat(directory)).isDirectory()) throw new Error('请选择远端文件夹')
    const entries = await host.io.fs.readdir(directory, { withFileTypes: true })
    return { path: directory, directories: entries.filter(item => item.isDirectory()).map(item => item.name).sort() }
  }
  disconnect(id: string): void {
    this.connecting.get(id)?.controller.abort(new Error('SSH 连接已取消'))
    this.connecting.delete(id)
    const host = this.connected.get(id)
    if (!host) return
    this.connected.delete(id); host.processes.close(); host.client.end()
  }
  /** File cleanup must work without deploying or starting the process component. */
  async withFiles<T>(id: string, operation: (fs: WorkspaceFileSystem, home: string) => Promise<T>, target?: string): Promise<T> {
    const current = this.connected.get(id)
    if (current) {
      const host = this.host(id, target)
      return operation(host.io.fs, host.home)
    }
    const transport = await this.authenticate(id, new AbortController().signal)
    if ('status' in transport) throw new Error('请先连接并确认服务器指纹')
    try {
      if (target && target !== transport.target) throw new Error('此会话绑定的 SSH 服务器与当前连接不同')
      return await operation(transport.fs, transport.home)
    }
    finally { transport.client.end() }
  }
  async cleanup(id: string): Promise<void> {
    this.connecting.get(id)?.controller.abort(new Error('SSH 连接已取消'))
    this.connecting.delete(id)
    this.connected.get(id)?.processes.close()
    try {
      await this.withFiles(id, (fs, home) => cleanupRemoteComponent(fs, path.posix.join(home, '.cache', 'whycode-remote')))
    } finally { this.disconnect(id) }
  }
  async remove(id: string): Promise<void> {
    const { connection } = await this.store.get(id)
    // Untrusted entries have never deployed a component and need no remote removal.
    if (connection.fingerprint) await this.cleanup(id)
    else this.disconnect(id)
    await this.store.remove(id)
  }
  close(): void { for (const id of new Set([...this.connected.keys(), ...this.connecting.keys()])) this.disconnect(id) }
}

function targetIdentity(connection: SshConnection, fingerprint: string): string {
  return `ssh:${connection.username}@${connection.host}:${connection.port}#${fingerprint}`
}
