import { Client } from '@modelcontextprotocol/sdk/client'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { McpHttpServerConfig, McpServerConfig } from './config.ts'
import {
  MCP_MAX_TOOLS_PER_SERVER,
  type McpAdvertisedTool,
} from './catalog.ts'

const MCP_LIST_MAX_PAGES = 100
export const MCP_CONNECTION_CONCURRENCY = 4

export type McpFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>
export interface McpOAuthTransport {
  authProvider: OAuthClientProvider
  fetchImpl: McpFetch
}
export type McpOAuthTransportFactory = (
  config: McpHttpServerConfig,
) => McpOAuthTransport | undefined

export function createMcpTransport(
  config: McpServerConfig,
  fetchImpl: McpFetch,
  oauthTransportFactory?: McpOAuthTransportFactory,
): Transport {
  if (config.transport === 'stdio') {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: 'pipe',
    })
    transport.stderr?.on('data', () => {})
    transport.stderr?.on('error', () => {})
    return transport
  }
  const oauth = oauthTransportFactory?.(config)
  return new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: oauth?.fetchImpl ?? fetchImpl,
    authProvider: oauth?.authProvider,
    requestInit: {
      headers: config.headers,
      credentials: 'omit',
      redirect: 'error',
    },
    reconnectionOptions: {
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 30_000,
      reconnectionDelayGrowFactor: 2,
      maxRetries: 5,
    },
  })
}

export async function listAllMcpTools(
  client: Client,
  signal: AbortSignal,
  timeout: number,
): Promise<McpAdvertisedTool[]> {
  const tools: McpAdvertisedTool[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MCP_LIST_MAX_PAGES; page++) {
    const result = await client.listTools(
      cursor ? { cursor } : undefined,
      { signal, timeout, maxTotalTimeout: timeout },
    )
    tools.push(...result.tools)
    if (tools.length > MCP_MAX_TOOLS_PER_SERVER) return tools
    if (!result.nextCursor) return tools
    if (cursors.has(result.nextCursor)) throw new Error('tools/list 返回了重复游标')
    cursors.add(result.nextCursor)
    cursor = result.nextCursor
  }
  throw new Error(`tools/list 分页超过 ${MCP_LIST_MAX_PAGES} 页上限`)
}

export function safeMcpConnectionError(
  error: unknown,
  config: McpServerConfig,
): string {
  if (error instanceof Error && error.name === 'AbortError') return '连接已取消'
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 401
  ) return '服务器要求登录，请在“连接 → MCP 服务”中完成认证'
  let message = error instanceof Error ? error.message : String(error)
  const redactions = config.transport === 'stdio'
    ? [config.command, config.cwd, ...config.args, ...Object.values(config.env)]
    : [config.url, ...Object.values(config.headers)]
  for (const value of redactions.filter((candidate) => candidate.length >= 3)) {
    message = message.replaceAll(value, '[已隐藏]')
  }
  return message
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[已隐藏地址]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [已隐藏]')
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 500) || '连接失败'
}

export async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (index < values.length) {
        const value = values[index++]
        if (value !== undefined) await operation(value)
      }
    },
  )
  await Promise.all(workers)
}

export function waitForMcpOperation(
  operation: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function abortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}
