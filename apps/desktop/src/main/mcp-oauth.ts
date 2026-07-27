import { randomBytes } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  McpBuiltinServerId,
  McpConfiguration,
  McpHttpServerConfig,
  McpOAuthTransport,
} from '@whycode/core'
import {
  mcpOAuthSessionKey,
  type McpOAuthSession,
} from './mcp-oauth-state.ts'
import {
  DesktopMcpOAuthProvider,
  mcpAuthorizationScope,
  safeMcpOAuthUrl,
  type McpRegisteredOAuthClient,
} from './mcp-oauth-provider.ts'

export const MCP_OAUTH_CALLBACK_URL = 'http://127.0.0.1:47168/mcp/oauth/callback'
const MCP_OAUTH_TIMEOUT_MS = 5 * 60_000

type McpOAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export type { McpRegisteredOAuthClient } from './mcp-oauth-provider.ts'

interface McpOAuthControllerOptions {
  fetchImpl: McpOAuthFetch
  openExternal: (url: string) => Promise<void>
  readSessions: () => readonly McpOAuthSession[]
  writeSessions: (sessions: readonly McpOAuthSession[]) => Promise<void>
  registeredClients?: Partial<Record<McpBuiltinServerId, McpRegisteredOAuthClient>>
  callbackUrl?: string
}

export interface McpOAuthAvailability {
  status: 'connected' | 'available' | 'client-registration-required' | 'unavailable'
  message?: string
}

export class McpOAuthController {
  private readonly options: McpOAuthControllerOptions
  private readonly callbackUrl: URL
  private persistenceTail: Promise<void> = Promise.resolve()
  private authorization: Promise<void> | null = null
  private callbackServer: Server | null = null

  constructor(options: McpOAuthControllerOptions) {
    this.options = options
    this.callbackUrl = validatedCallbackUrl(options.callbackUrl ?? MCP_OAUTH_CALLBACK_URL)
  }

  availability(config: McpHttpServerConfig): McpOAuthAvailability {
    if (!safeMcpOAuthUrl(new URL(config.url))) {
      return {
        status: 'unavailable',
        message: 'MCP OAuth 只允许 HTTPS，或本机 loopback HTTP 连接。',
      }
    }
    const session = this.readSession(config)
    if (session?.tokens) return { status: 'connected' }
    if (config.builtinId === 'github' && !this.registeredClient(config)) {
      return {
        status: 'client-registration-required',
        message: 'GitHub 不支持匿名访问或动态客户端注册；当前发行版需配置 WhyCode GitHub App，或使用 PAT。',
      }
    }
    return { status: 'available' }
  }

  isAuthorizing(): boolean {
    return this.authorization !== null
  }

  runtimeTransport(config: McpHttpServerConfig): McpOAuthTransport | undefined {
    if (!safeMcpOAuthUrl(new URL(config.url))) return undefined
    if (hasAuthorizationHeader(config.headers)) return undefined
    const session = this.readSession(config)
    if (!session?.tokens) return undefined
    return {
      authProvider: new DesktopMcpOAuthProvider(this, config, false),
      fetchImpl: (input, init) => this.fetchOAuth(input, init),
    }
  }

  runtimeConfiguration(configuration: McpConfiguration): McpConfiguration {
    const servers = configuration.servers.filter((server) => (
      server.transport !== 'http'
      || server.builtinId !== 'github'
      || hasAuthorizationHeader(server.headers)
      || Boolean(this.readSession(server)?.tokens)
    ))
    if (servers.length === configuration.servers.length) return configuration
    const unavailable = configuration.servers.filter((server) => !servers.includes(server))
    return {
      ...configuration,
      servers,
      diagnostics: [
        ...configuration.diagnostics,
        ...unavailable.map((server) => ({
          scope: server.scope,
          server: server.name,
          message: server.scope === 'global'
            ? 'GitHub 官方 MCP 不支持匿名访问；请在“连接 → MCP 服务”中使用 OAuth 或 PAT 登录'
            : 'GitHub 官方 MCP 不支持匿名访问；项目配置需通过环境变量提供 Authorization',
        })),
      ],
      projectServerCount: servers.filter((server) => server.scope === 'project').length,
    }
  }

  authorize(config: McpHttpServerConfig): Promise<void> {
    if (this.authorization) throw new Error('已有 MCP OAuth 登录正在进行')
    if (!safeMcpOAuthUrl(new URL(config.url))) {
      throw new Error('MCP OAuth 只允许 HTTPS，或本机 loopback HTTP 连接')
    }
    if (hasAuthorizationHeader(config.headers)) {
      throw new Error('当前服务器已经配置 Authorization Header；请先清除后再使用 OAuth')
    }
    if (config.builtinId === 'github' && !this.registeredClient(config)) {
      throw new Error(
        'GitHub 官方远程 MCP 不支持匿名访问或动态客户端注册。'
        + ` 请先使用 PAT；若要启用一键登录，WhyCode 发行版需注册 GitHub App，并把回调地址设为 ${this.callbackUrl.href}`,
      )
    }
    const operation = this.authorizeUnshared(config).finally(() => {
      if (this.authorization === operation) this.authorization = null
    })
    this.authorization = operation
    return operation
  }

  async disconnect(config: McpHttpServerConfig): Promise<void> {
    await this.updateSession(config, () => undefined)
  }

  async close(): Promise<void> {
    const server = this.callbackServer
    this.callbackServer = null
    if (server) await closeServer(server)
    await this.persistenceTail.catch(() => {})
  }

  currentSession(config: McpHttpServerConfig): McpOAuthSession | undefined {
    return this.readSession(config)
  }

  redirectUrl(): URL {
    return new URL(this.callbackUrl)
  }

  async openAuthorization(url: URL): Promise<void> {
    await this.options.openExternal(url.href)
  }

  registeredClient(config: McpHttpServerConfig): McpRegisteredOAuthClient | undefined {
    return config.builtinId
      ? this.options.registeredClients?.[config.builtinId]
      : undefined
  }

  async saveSession(
    config: McpHttpServerConfig,
    next: Omit<McpOAuthSession, 'serverName' | 'connectionFingerprint'>,
  ): Promise<void> {
    await this.updateSession(config, () => ({
      serverName: config.name,
      connectionFingerprint: connectionFingerprint(config),
      ...next,
    }))
  }

  private async authorizeUnshared(config: McpHttpServerConfig): Promise<void> {
    const state = randomBytes(32).toString('base64url')
    const callback = await this.listenForCallback(state)
    const provider = new DesktopMcpOAuthProvider(this, config, true, state)
    try {
      const result = await auth(provider, {
        serverUrl: config.url,
        scope: mcpAuthorizationScope(config, this.registeredClient(config)),
        fetchFn: (input, init) => this.fetchOAuth(input, init),
      })
      if (result === 'AUTHORIZED') return
      const authorizationCode = await callback.result
      const completed = await auth(provider, {
        serverUrl: config.url,
        authorizationCode,
        scope: mcpAuthorizationScope(config, this.registeredClient(config)),
        fetchFn: (input, init) => this.fetchOAuth(input, init),
      })
      if (completed !== 'AUTHORIZED') throw new Error('MCP OAuth 授权未完成')
    } catch (error) {
      throw new Error(safeOAuthError(error, this.registeredClient(config)))
    } finally {
      callback.close()
      if (this.callbackServer === callback.server) this.callbackServer = null
      await closeServer(callback.server)
    }
  }

  private readSession(config: McpHttpServerConfig): McpOAuthSession | undefined {
    if (config.scope !== 'global') return undefined
    const target = {
      serverName: config.name,
      connectionFingerprint: connectionFingerprint(config),
    }
    const key = mcpOAuthSessionKey(target)
    return this.options.readSessions().find((session) =>
      mcpOAuthSessionKey(session) === key)
  }

  private async fetchOAuth(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = oauthFetchUrl(input)
    if (!safeMcpOAuthUrl(url)) {
      throw new Error('MCP OAuth 网络请求只允许 HTTPS，或本机 loopback HTTP 连接')
    }
    return this.options.fetchImpl(input, {
      ...init,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    })
  }

  private updateSession(
    config: McpHttpServerConfig,
    update: (current: McpOAuthSession | undefined) => McpOAuthSession | undefined,
  ): Promise<void> {
    const target = {
      serverName: config.name,
      connectionFingerprint: connectionFingerprint(config),
    }
    const key = mcpOAuthSessionKey(target)
    const operation = this.persistenceTail.then(async () => {
      const sessions = new Map(
        this.options.readSessions().map((session) => [mcpOAuthSessionKey(session), session]),
      )
      const next = update(sessions.get(key))
      if (next) sessions.set(key, next)
      else sessions.delete(key)
      await this.options.writeSessions([...sessions.values()])
    })
    this.persistenceTail = operation.catch(() => {})
    return operation
  }

  private async listenForCallback(state: string): Promise<OAuthCallback> {
    const expectedPath = this.callbackUrl.pathname
    let resolveCode: (code: string) => void
    let rejectCode: (error: Error) => void
    const result = new Promise<string>((resolve, reject) => {
      resolveCode = resolve
      rejectCode = reject
    })
    const server = createServer((request, response) => {
      let requestUrl: URL
      try {
        requestUrl = new URL(request.url ?? '/', this.callbackUrl.origin)
      } catch {
        response.writeHead(400).end()
        return
      }
      if (request.method !== 'GET' || requestUrl.pathname !== expectedPath) {
        response.writeHead(404).end()
        return
      }
      if (requestUrl.searchParams.get('state') !== state) {
        respondHtml(response, 400, 'WhyCode 拒绝了无效的 OAuth 回调，请返回应用重试。')
        return
      }
      const oauthError = requestUrl.searchParams.get('error')
      if (oauthError) {
        const description = requestUrl.searchParams.get('error_description')
        respondHtml(response, 400, 'MCP OAuth 登录未完成，可以关闭此页面。')
        rejectCode(new Error(description || oauthError))
        return
      }
      const code = requestUrl.searchParams.get('code')
      if (!code) {
        respondHtml(response, 400, 'OAuth 回调缺少授权码，请返回应用重试。')
        return
      }
      respondHtml(response, 200, '授权已返回 WhyCode，可以关闭此页面。')
      resolveCode(code)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(Number(this.callbackUrl.port), this.callbackUrl.hostname, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.callbackServer = server
    const timer = setTimeout(() => {
      rejectCode(new Error('MCP OAuth 登录等待超时'))
    }, MCP_OAUTH_TIMEOUT_MS)
    timer.unref()
    return {
      server,
      result: result.finally(() => clearTimeout(timer)),
      close: () => clearTimeout(timer),
    }
  }
}

interface OAuthCallback {
  server: Server
  result: Promise<string>
  close(): void
}

function connectionFingerprint(config: McpHttpServerConfig): string {
  const configured = config.connectionFingerprint
  if (!configured) throw new Error('MCP OAuth 连接缺少来源指纹')
  return configured
}

function hasAuthorizationHeader(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
}

function oauthFetchUrl(input: string | URL | Request): URL {
  return input instanceof URL
    ? input
    : new URL(typeof input === 'string' ? input : input.url)
}

function validatedCallbackUrl(value: string): URL {
  const url = new URL(value)
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || !url.port
    || !url.pathname.startsWith('/')
  ) throw new Error('MCP OAuth 回调必须使用带固定端口的 127.0.0.1 HTTP 地址')
  return url
}

function safeOAuthError(
  error: unknown,
  registered?: McpRegisteredOAuthClient,
): string {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of [registered?.clientId, registered?.clientSecret]) {
    if (secret) message = message.replaceAll(secret, '[已隐藏]')
  }
  if (/dynamic client registration/iu.test(message)) {
    return '授权服务器不支持动态客户端注册；需要为 WhyCode 预先注册 OAuth 客户端'
  }
  return message
    .replace(/https?:\/\/[^\s"'<>]+/giu, '[已隐藏地址]')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [已隐藏]')
    .replace(
      /\b(access_token|refresh_token|client_secret|authorization_code)\b\s*[:=]\s*\S+/giu,
      '$1=[已隐藏]',
    )
    .replace(/[\r\n]+/gu, ' ')
    .slice(0, 500) || 'MCP OAuth 登录失败'
}

function respondHtml(
  response: ServerResponse,
  status: number,
  message: string,
): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  response.end(
    '<!doctype html><meta charset="utf-8"><title>WhyCode MCP OAuth</title>'
    + `<p>${escapeHtml(message)}</p>`,
  )
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!)
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
