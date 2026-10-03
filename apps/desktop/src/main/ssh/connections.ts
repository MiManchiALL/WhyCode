import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { Client } from 'ssh2'
import type { WorkspaceFileSystem, WorkspaceIO } from '@whycode/core'
import type { SshConnection, SshConnectionInput, SshConnectionStatus, SshConnectResult, SshDirectory } from '../../shared/ssh.ts'
import { SshConnectionMissingError, SshConnectionStore } from './store.ts'
import { createSftpFileSystem } from './sftp.ts'
import { execChannel, provisionRemote, quoteShell, removeRemoteEnvironment } from './provision.ts'
import { cleanupRemoteComponent, prepareRemoteComponent, readComponentIdentity, type RemoteComponent } from './component.ts'
import { RemoteProcessHost } from './process.ts'
import type { SshReleaseOptions } from '../../shared/ssh-skills.ts'
import { cleanManagedSkills } from './skill-remote.ts'
import { remoteSkillIO } from './skill-files.ts'

interface ConnectedHost {
  client: Client
  io: WorkspaceIO
  home: string
  target: string
  component: RemoteComponent
  processes: RemoteProcessHost
}
interface AuthenticatedHost { client: Client; fs: WorkspaceFileSystem; home: string; target: string }
type ConnectionState =
  | { status: 'connected'; host: ConnectedHost }
  | { status: 'disconnected'; component: RemoteComponent }
  | { status: 'connecting'; promise: Promise<SshConnectResult>; controller: AbortController; component?: RemoteComponent }
  | { status: 'releasing'; component?: RemoteComponent }

export class SshCredentialsRequiredError extends Error {}

export class SshConnections extends EventEmitter<{ changed: []; connected: [id: string] }> {
  private readonly states = new Map<string, ConnectionState>()
  private readonly skillOperations = new Map<string, string>()
  readonly store: SshConnectionStore
  private readonly resources: string
  constructor(store: SshConnectionStore, resources: string) { super(); this.store = store; this.resources = resources }
  status(id: string): SshConnectionStatus { return this.states.get(id)?.status ?? 'disconnected' }
  isConnected(id: string): boolean { return this.states.get(id)?.status === 'connected' }
  isTargetConnected(target: string): boolean {
    return [...this.states.values()].some(state => state.status === 'connected' && state.host.target === target)
  }

  async save(input: SshConnectionInput): Promise<SshConnection> {
    if (input.id && (['connecting', 'releasing'].includes(this.status(input.id)) || this.skillOperations.has(input.id))) throw new Error('SSH 连接正在处理，请稍后再编辑')
    const connection = await this.store.save(input)
    if (input.id) this.disconnect(input.id)
    this.emit('changed')
    return connection
  }

  async configuredTargets(): Promise<Map<string, string>> {
    return new Map((await this.store.list()).flatMap(connection => connection.fingerprint
      ? [[targetIdentity(connection, connection.fingerprint), connection.id]] : []))
  }
  async connectionIdForTarget(target: string): Promise<string> {
    const active = [...this.states].find(([, state]) => state.status === 'connected' && state.host.target === target)
    const id = active?.[0] ?? (await this.configuredTargets()).get(target)
    if (!id) throw new SshConnectionMissingError()
    return id
  }
  targetHost(target: string): ConnectedHost {
    for (const state of this.states.values()) {
      if (state.status === 'connected' && state.host.target === target) return state.host
    }
    throw new Error('SSH 未连接，请在连接设置中连接原服务器')
  }

  /** 只有本次运行中成功连接后意外断开的通道，才允许由新操作恢复。 */
  resume(id: string): Promise<SshConnectResult> {
    if (!this.states.has(id)) return Promise.reject(new Error('SSH 未连接，请先点击会话顶部或设置中的“连接”'))
    return this.connect(id)
  }
  connect(id: string, fingerprint?: string, secret?: string): Promise<SshConnectResult> {
    const current = this.states.get(id)
    if (current?.status === 'connected') return Promise.resolve({ status: 'connected', home: current.host.home })
    if (current?.status === 'connecting') return current.promise
    if (current?.status === 'releasing') return Promise.reject(new Error('SSH 连接正在清理，请稍后再连接'))
    const controller = new AbortController()
    const promise = Promise.resolve().then(() => this.open(id, pending, fingerprint, secret)).finally(() => {
      if (this.states.get(id) !== pending) return
      if (current?.status === 'disconnected') this.states.set(id, current)
      else this.states.delete(id)
      this.emit('changed')
    })
    const pending: Extract<ConnectionState, { status: 'connecting' }> = { status: 'connecting', promise, controller }
    this.states.set(id, pending)
    this.emit('changed')
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
  private async open(id: string, pending: Extract<ConnectionState, { status: 'connecting' }>, approved?: string, suppliedSecret?: string): Promise<SshConnectResult> {
    const signal = pending.controller.signal
    const transport = await this.authenticate(id, signal, approved, suppliedSecret)
    if ('status' in transport) return transport
    const { client, fs, home, target } = transport
    try {
      const component = await prepareRemoteComponent(fs, home)
      pending.component = component
      if ([...this.states.values()].some(state => state.status === 'releasing' && state.component?.identity === component.identity)) {
        throw new Error('此服务器的远端组件正在清理，请稍后再连接')
      }
      // 共用目录的安装按已经开始的连接排序，避免上传与清理交错。
      const installing = [...this.states.values()].flatMap(state => state !== pending && state.status === 'connecting' && state.component?.identity === component.identity ? [state.promise] : [])
      await Promise.allSettled(installing)
      signal.throwIfAborted()
      const installed = await provisionRemote(client, fs, component, this.resources)
      signal.throwIfAborted()
      const processes = new RemoteProcessHost(await execChannel(client, `exec ${quoteShell(installed.executable)}`), () => client.end())
      await processes.ready()
      signal.throwIfAborted()
      const io: WorkspaceIO = {
        identity: target, platform: 'linux', path: path.posix, fs,
        spawn: (command, cwd) => processes.spawn(command, cwd),
        ripgrep: (args, cwd) => processes.spawn({ executable: installed.ripgrep, args }, cwd),
      }
      const host: ConnectedHost = { client, io, home, target, processes, component }
      const active: ConnectionState = { status: 'connected', host }
      this.states.set(id, active)
      this.emit('changed')
      this.emit('connected', id)
      client.once('close', () => {
        if (this.states.get(id) === active) { this.states.set(id, { status: 'disconnected', component }); this.emit('changed') }
        processes.close()
      })
      return { status: 'connected', home }
    } catch (error) {
      client.end()
      signal.throwIfAborted()
      throw error
    }
  }
  host(id: string, target?: string): ConnectedHost {
    const state = this.states.get(id)
    if (state?.status !== 'connected') throw new Error('SSH 未连接，请在连接设置中连接服务器')
    const host = state.host
    if (target && target !== host.target) throw new Error('此会话绑定的 SSH 服务器与当前连接不同')
    return host
  }
  /** Operations resolve the live channel each time, but never reconnect or replay automatically. */
  io(target: string): WorkspaceIO {
    const fs = new Proxy({} as WorkspaceIO['fs'], { get: (_value, key) => (...args: unknown[]) => {
      const files = this.targetHost(target).io.fs
      const operation = files[key as keyof typeof files] as (...args: unknown[]) => unknown
      return operation.apply(files, args)
    } })
    return {
      identity: target, platform: 'linux', path: path.posix, fs,
      spawn: (command, cwd) => this.targetHost(target).processes.spawn(command, cwd),
      ripgrep: (args, cwd) => this.targetHost(target).io.ripgrep!(args, cwd),
    }
  }
  async directory(id: string, value?: string): Promise<SshDirectory> {
    const host = this.host(id)
    const directory = await host.io.fs.realpath(value ? path.posix.resolve(host.home, value) : host.home)
    if (!(await host.io.fs.stat(directory)).isDirectory()) throw new Error('请选择远端文件夹')
    const entries = await host.io.fs.readdir(directory, { withFileTypes: true })
    return { path: directory, directories: entries.filter(item => item.isDirectory()).map(item => item.name).sort() }
  }
  disconnect(id: string): void {
    const current = this.states.get(id)
    if (current?.status === 'releasing') return
    this.states.delete(id)
    if (current?.status === 'connecting') current.controller.abort(new Error('SSH 连接已取消'))
    if (current?.status === 'connected') { current.host.processes.close(); current.host.client.end() }
    if (current) this.emit('changed')
  }
  /** File cleanup must work without deploying or starting the process component. */
  async withFiles<T>(id: string, operation: (fs: WorkspaceFileSystem, home: string, client: Client) => Promise<T>, target?: string): Promise<T> {
    if (this.isConnected(id)) {
      const host = this.host(id, target)
      return operation(host.io.fs, host.home, host.client)
    }
    const transport = await this.authenticate(id, new AbortController().signal)
    if ('status' in transport) throw new Error('请先连接并确认服务器指纹')
    try {
      if (target && target !== transport.target) throw new Error('此会话绑定的 SSH 服务器与当前连接不同')
      return await operation(transport.fs, transport.home, transport.client)
    }
    finally { transport.client.end() }
  }
  async withSkillFiles<T>(id: string, operation: (fs: WorkspaceFileSystem, home: string, client: Client) => Promise<T>): Promise<T> {
    if (['connecting', 'releasing'].includes(this.status(id))) throw new Error('SSH 连接正在处理，请稍后管理 Skill')
    return this.withFiles(id, (fs, home, client) => this.withSkillLock(id, fs, home, () => operation(fs, home, client)))
  }
  private async withSkillLock<T>(id: string, fs: WorkspaceFileSystem, home: string, operation: (fs: WorkspaceFileSystem, home: string) => Promise<T>, releasing = false): Promise<T> {
    if (this.skillOperations.has(id)) throw new Error('此服务器账号的 Skill 操作仍在后台进行，请稍后重试')
    this.skillOperations.set(id, `pending:${id}`)
    try {
      const key = `${(await this.store.get(id)).connection.fingerprint}:${home}`
      if ([...this.skillOperations.values()].includes(key)) throw new Error('此服务器账号的 Skill 操作仍在后台进行，请稍后重试')
      if (!releasing && this.status(id) === 'releasing') throw new Error('SSH 连接正在清理，请稍后管理 Skill')
      this.skillOperations.set(id, key)
      return await operation(fs, home)
    }
    finally { this.skillOperations.delete(id) }
  }
  private assertSkillsIdle(id: string, component?: RemoteComponent): void {
    if (this.skillOperations.has(id) || (component && [...this.skillOperations.keys()].some(key => componentOf(this.states.get(key))?.identity === component.identity))) {
      throw new Error('此服务器账号的 Skill 操作仍在后台进行，请稍后重试')
    }
  }
  async removeLocal(id: string): Promise<void> {
    this.assertSkillsIdle(id)
    if (this.status(id) === 'releasing') throw new Error('连接仍在清理，请等待完成后重试')
    this.disconnect(id)
    await this.store.remove(id)
    this.emit('changed')
  }
  cleanup(id: string, options: SshReleaseOptions = {}): Promise<string[]> { return this.release(id, false, options) }
  remove(id: string, options: SshReleaseOptions = {}): Promise<string[]> { return this.release(id, true, options) }
  private release(id: string, remove: boolean, options: SshReleaseOptions): Promise<string[]> {
    const current = this.states.get(id)
    if (current?.status === 'releasing') return Promise.reject(new Error('SSH 连接正在清理，请稍后重试'))
    const host = current?.status === 'connected' ? current.host : null
    const releasing: Extract<ConnectionState, { status: 'releasing' }> = { status: 'releasing', component: componentOf(current) }
    try { this.assertSkillsIdle(id, releasing.component) } catch (error) { return Promise.reject(error) }
    if (releasing.component && [...this.states.values()].some(state => state.status === 'releasing' && state.component?.identity === releasing.component!.identity)) {
      return Promise.reject(new Error('此服务器的远端组件正在清理，请稍后重试'))
    }
    const stopped = new Map<string, ConnectionState>()
    const stop = (connectionId: string, state: ConnectionState | undefined) => {
      if (state) stopped.set(connectionId, state)
      this.states.set(connectionId, releasing)
      if (state?.status === 'connecting') state.controller.abort(new Error('远端组件正在清理，SSH 连接已取消'))
      if (state?.status === 'connected') state.host.processes.close()
    }
    const stopRelated = (component: RemoteComponent) => {
      const related = [...this.states].filter(([, state]) => componentOf(state)?.identity === component.identity)
      if (related.some(([, state]) => state.status === 'releasing' && state !== releasing)) throw new Error('此服务器的远端组件正在清理，请稍后重试')
      releasing.component = component
      for (const [connectionId, state] of related) if (state !== releasing) stop(connectionId, state)
      this.emit('changed')
    }
    const waitForInstallers = () => Promise.allSettled([...stopped.values()].flatMap(state => state.status === 'connecting' ? [state.promise] : []))
    stop(id, current)
    if (releasing.component) stopRelated(releasing.component)
    else this.emit('changed')
    const promise = Promise.resolve().then(async () => {
      const preserved: string[] = []
      await waitForInstallers()
      // 未经认证的配置从未部署组件；清理复用现有 SFTP，且期间禁止重新部署。
      if (!remove || (await this.store.get(id)).connection.fingerprint) {
        const clean = async (fs: WorkspaceFileSystem, home: string, client: Client) => {
          const directory = path.posix.join(home, '.cache', 'whycode-remote')
          const identity = await readComponentIdentity(fs, directory)
          this.assertSkillsIdle(id, identity ? { directory, identity } : undefined)
          if (identity) stopRelated({ directory, identity })
          await waitForInstallers()
          if (options.cleanSkills) {
            const results = await this.withSkillLock(id, fs, home, () => cleanManagedSkills(remoteSkillIO(fs, home, client), home, options), true)
            const failures = results.filter(result => !result.ok)
            if (failures.length) throw new Error(failures.map(result => `${result.name}：${result.message}`).join('\n'))
            preserved.push(...results.filter(result => result.preserved).map(result => result.name))
          }
          await cleanupRemoteComponent(fs, directory, environment => removeRemoteEnvironment(client, environment))
        }
        if (host) await clean(host.io.fs, host.home, host.client)
        else await this.withFiles(id, clean)
      }
      if (remove) await this.store.remove(id)
      return preserved
    }).finally(() => {
      for (const state of stopped.values()) if (state.status === 'connected') state.host.client.end()
      for (const [connectionId, state] of this.states) if (state === releasing) this.states.delete(connectionId)
      this.emit('changed')
    })
    return promise
  }
  close(): void { for (const id of this.states.keys()) this.disconnect(id) }
}

function componentOf(state: ConnectionState | undefined): RemoteComponent | undefined {
  return state?.status === 'connected' ? state.host.component : state?.component
}

function targetIdentity(connection: SshConnection, fingerprint: string): string {
  return `ssh:${connection.username}@${connection.host}:${connection.port}#${fingerprint}`
}
