import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpTransportFactory, WorkspaceProcess } from '@whycode/core'
import type { Client } from 'ssh2'
import type { EventEmitter } from 'node:events'
import type { SshConnections } from './connections.ts'
import { execChannel, quoteShell } from './provision.ts'
import { sshFetch } from './http.ts'

/** 使用现有进程宿主管理退出、进程组与输出背压，协议 framing 复用 MCP SDK。 */
export class SshMcpStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private process?: WorkspaceProcess
  private readonly buffer = new ReadBuffer()
  private closed = false
  private readonly spawn: () => WorkspaceProcess
  constructor(spawn: () => WorkspaceProcess) { this.spawn = spawn }

  async start(): Promise<void> {
    if (this.process || this.closed) throw new Error('MCP 传输已启动或关闭')
    const process = this.spawn()
    this.process = process
    process.stdout.on('data', (chunk: Buffer) => {
      try {
        this.buffer.append(chunk)
        let message: JSONRPCMessage | null
        while ((message = this.buffer.readMessage()) !== null) this.onmessage?.(message)
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)))
        void this.close().catch(() => {})
      }
    })
    process.stderr.resume()
    const emitters: EventEmitter[] = [process, process.stdout, process.stderr, process.stdin]
    for (const emitter of emitters) emitter.on('error', (error: Error) => this.onerror?.(error))
    process.once('close', () => this.finish())
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const process = this.process
    if (!process || this.closed) throw new Error('MCP 传输未连接')
    await new Promise<void>((resolve, reject) => {
      process.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve())
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.process && !await this.process.terminate()) throw new Error('未能确认远端 MCP 进程已停止，请检查 SSH 连接后重试')
    this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.closed = true
    this.buffer.clear()
    this.onclose?.()
  }
}

export function remoteMcpTransport(connections: SshConnections, target: string): McpTransportFactory {
  return config => {
    if (config.scope !== 'project') return undefined
    if (config.transport === 'stdio') {
      const command = ['exec', 'env', '--', ...Object.entries(config.env).map(([name, value]) =>
        quoteShell(`${name}=${value}`)), quoteShell(config.command), ...config.args.map(quoteShell)].join(' ')
      return new SshMcpStdioTransport(() => connections.targetHost(target).processes.spawn(command, config.cwd))
    }
    return new StreamableHTTPClientTransport(new URL(config.url), {
      fetch: (input, init) => sshFetch(connections.targetHost(target).client, input, init),
      requestInit: { headers: config.headers, credentials: 'omit', redirect: 'error' },
      reconnectionOptions: { initialReconnectionDelay: 1_000, maxReconnectionDelay: 30_000, reconnectionDelayGrowFactor: 2, maxRetries: 5 },
    })
  }
}

export async function remoteMcpEnvironment(client: Client, names: readonly string[]): Promise<NodeJS.ProcessEnv> {
  if (names.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))) throw new Error('环境变量名称无效')
  if (!names.length) return {}
  const command = names.map(name => `if [ "\${${name}+x}" ]; then printf '%s\\0%s\\0' ${quoteShell(name)} "$${name}"; fi`).join('\n')
  const channel = await execChannel(client, command)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const fail = (error: Error) => { clearTimeout(timer); channel.close(); reject(error) }
    const timer = setTimeout(() => fail(new Error('读取远端 MCP 环境超时')), 10_000)
    channel.stderr.resume()
    channel.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 256 * 1024) fail(new Error('远端 MCP 环境变量过大'))
      else chunks.push(chunk)
    })
    channel.once('error', fail)
    channel.once('close', (code: number) => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error('读取远端 MCP 环境失败')); return }
      const fields = Buffer.concat(chunks).toString('utf8').split('\0')
      const environment: NodeJS.ProcessEnv = Object.create(null)
      for (let index = 0; index + 1 < fields.length; index += 2) {
        if (!names.includes(fields[index]!)) { reject(new Error('远端 MCP 环境响应无效')); return }
        environment[fields[index]!] = fields[index + 1]!
      }
      resolve(environment)
    })
  })
}
