import assert from 'node:assert/strict'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { describe, it } from 'node:test'
import {
  MCP_GITHUB_BUILTIN,
  type McpHttpServerConfig,
} from '@whycode/core'
import {
  McpOAuthController,
  type McpRegisteredOAuthClient,
} from './mcp-oauth.ts'
import type { McpOAuthSession } from './mcp-oauth-state.ts'

describe('MCP OAuth', () => {
  it('按标准发现、动态注册与 PKCE 回调保存令牌，并按 URL 指纹供运行时复用', async () => {
    const oauth = await createOAuthFixture()
    const callbackPort = await reservePort()
    const callbackUrl = `http://127.0.0.1:${callbackPort}/mcp/oauth/callback`
    let sessions: McpOAuthSession[] = []
    let authorizationUrl: URL | undefined
    const controller = new McpOAuthController({
      fetchImpl: fetch,
      callbackUrl,
      readSessions: () => sessions,
      writeSessions: async (next) => {
        sessions = structuredClone(next) as McpOAuthSession[]
      },
      openExternal: async (url) => {
        authorizationUrl = new URL(url)
        const state = authorizationUrl.searchParams.get('state')
        assert.ok(state)
        assert.ok(authorizationUrl.searchParams.get('code_challenge'))
        const rejectedCallback = new URL(callbackUrl)
        rejectedCallback.searchParams.set('code', 'attacker-code')
        rejectedCallback.searchParams.set('state', 'wrong-state')
        assert.equal((await fetch(rejectedCallback)).status, 400)
        const callback = new URL(callbackUrl)
        callback.searchParams.set('code', 'accepted-code')
        callback.searchParams.set('state', state)
        const response = await fetch(callback)
        assert.equal(response.status, 200)
      },
    })
    const config = httpConfig(oauth.mcpUrl)
    try {
      assert.equal(controller.availability(config).status, 'available')
      await controller.authorize(config)
      assert.equal(authorizationUrl?.origin, oauth.origin)
      assert.equal(oauth.registrationCount(), 1)
      assert.equal(oauth.tokenExchangeCount(), 1)
      assert.equal(controller.availability(config).status, 'connected')
      assert.equal(sessions[0]?.tokens?.access_token, 'access-token')
      assert.equal(sessions[0]?.clientInformation?.client_id, 'dynamic-client')
      const runtimeTransport = controller.runtimeTransport(config)
      assert.ok(runtimeTransport)
      await assert.rejects(
        runtimeTransport.fetchImpl('http://auth.example.test/token'),
        /网络请求只允许 HTTPS/,
      )

      const changed = {
        ...config,
        url: `${oauth.origin}/other-mcp`,
        connectionFingerprint: 'b'.repeat(64),
      }
      assert.equal(controller.availability(changed).status, 'available')
      assert.equal(controller.runtimeTransport(changed), undefined)

      const projectGithub = {
        ...config,
        scope: 'project' as const,
        builtinId: 'github' as const,
      }
      assert.equal(controller.runtimeTransport(projectGithub), undefined)
      const isolated = controller.runtimeConfiguration({
        servers: [projectGithub],
        configuredServers: [],
        diagnostics: [],
        projectConfigDigest: 'project-digest',
        projectServerCount: 1,
      })
      assert.deepEqual(isolated.servers, [])
      assert.equal(isolated.projectServerCount, 0)

      await controller.disconnect(config)
      assert.deepEqual(sessions, [])
    } finally {
      await controller.close()
      await closeServer(oauth.server)
    }
  })

  it('GitHub 无宿主客户端时明确要求注册或 PAT，已有 PAT 时不混用 OAuth', async () => {
    let networkCalls = 0
    const github = httpConfig(MCP_GITHUB_BUILTIN.server.url, {
      builtinId: 'github',
    })
    const controller = new McpOAuthController({
      fetchImpl: async () => {
        networkCalls++
        throw new Error('不应联网')
      },
      openExternal: async () => {},
      readSessions: () => [],
      writeSessions: async () => {},
    })
    const insecure = httpConfig('http://mcp.example.test/')
    assert.equal(controller.availability(insecure).status, 'unavailable')
    assert.throws(() => controller.authorize(insecure), /只允许 HTTPS/)
    assert.equal(networkCalls, 0)

    assert.equal(controller.availability(github).status, 'client-registration-required')
    assert.throws(() => controller.authorize(github), /不支持匿名访问或动态客户端注册/)
    assert.equal(networkCalls, 0)
    const gated = controller.runtimeConfiguration({
      servers: [github],
      configuredServers: [],
      diagnostics: [],
      projectConfigDigest: null,
      projectServerCount: 0,
    })
    assert.deepEqual(gated.servers, [])
    assert.match(gated.diagnostics[0]?.message ?? '', /不支持匿名访问/)

    const pat = {
      ...github,
      headers: { Authorization: 'Bearer secret' },
    }
    assert.equal(controller.runtimeTransport(pat), undefined)
    assert.throws(() => controller.authorize(pat), /已经配置 Authorization Header/)
    assert.deepEqual(
      controller.runtimeConfiguration({ ...gated, servers: [pat], diagnostics: [] }).servers,
      [pat],
    )
  })

  it('拒绝受保护资源元数据把 OAuth 发现或令牌请求降级到远程明文 HTTP', async () => {
    const callbackPort = await reservePort()
    const requestedUrls: string[] = []
    const controller = new McpOAuthController({
      callbackUrl: `http://127.0.0.1:${callbackPort}/mcp/oauth/callback`,
      fetchImpl: async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        requestedUrls.push(url)
        return new Response(JSON.stringify({
          resource: 'https://mcp.example.test/mcp',
          authorization_servers: ['http://auth.example.test'],
        }), {
          headers: { 'Content-Type': 'application/json' },
        })
      },
      openExternal: async () => assert.fail('不应打开不安全的授权地址'),
      readSessions: () => [],
      writeSessions: async () => {},
    })
    try {
      await assert.rejects(
        controller.authorize(httpConfig('https://mcp.example.test/mcp')),
        /网络请求只允许 HTTPS/,
      )
      assert.equal(requestedUrls.length, 1)
      assert.match(requestedUrls[0] ?? '', /^https:/u)
    } finally {
      await controller.close()
    }
  })

  it('预注册客户端让 GitHub 复用同一 OAuth 主通道，并按 client_secret_post 换取令牌', async () => {
    const oauth = await createOAuthFixture({
      dynamicRegistration: false,
      tokenAuthMethods: ['client_secret_post'],
    })
    const callbackPort = await reservePort()
    const callbackUrl = `http://127.0.0.1:${callbackPort}/mcp/oauth/callback`
    const client: McpRegisteredOAuthClient = {
      clientId: 'whycode-client',
      clientSecret: 'whycode-secret',
      tokenEndpointAuthMethod: 'client_secret_post',
    }
    let sessions: McpOAuthSession[] = []
    const controller = new McpOAuthController({
      fetchImpl: fetch,
      callbackUrl,
      openExternal: async (url) => {
        const authorizationUrl = new URL(url)
        const state = authorizationUrl.searchParams.get('state')
        assert.ok(state)
        const callback = new URL(callbackUrl)
        callback.searchParams.set('code', 'accepted-code')
        callback.searchParams.set('state', state)
        assert.equal((await fetch(callback)).status, 200)
      },
      readSessions: () => sessions,
      writeSessions: async (next) => {
        sessions = structuredClone(next) as McpOAuthSession[]
      },
      registeredClients: { github: client },
    })
    const config = httpConfig(oauth.mcpUrl, { builtinId: 'github' })
    try {
      assert.equal(controller.availability(config).status, 'available')
      await controller.authorize(config)
      assert.equal(oauth.registrationCount(), 0)
      assert.equal(oauth.tokenExchangeCount(), 1)
      assert.equal(oauth.lastTokenRequest()?.get('client_id'), client.clientId)
      assert.equal(oauth.lastTokenRequest()?.get('client_secret'), client.clientSecret)
      assert.equal(sessions[0]?.clientInformation?.client_id, client.clientId)
      assert.equal(
        sessions[0]?.clientInformation
        && 'token_endpoint_auth_method' in sessions[0].clientInformation
          ? sessions[0].clientInformation.token_endpoint_auth_method
          : undefined,
        'client_secret_post',
      )
      assert.ok(controller.runtimeTransport(config))
    } finally {
      await controller.close()
      await closeServer(oauth.server)
    }
  })
})

async function createOAuthFixture(options: {
  dynamicRegistration?: boolean
  tokenAuthMethods?: string[]
} = {}): Promise<{
  server: Server
  origin: string
  mcpUrl: string
  registrationCount(): number
  tokenExchangeCount(): number
  lastTokenRequest(): URLSearchParams | undefined
}> {
  let origin = ''
  let registrations = 0
  let tokenExchanges = 0
  let lastTokenRequest: URLSearchParams | undefined
  const dynamicRegistration = options.dynamicRegistration ?? true
  const tokenAuthMethods = options.tokenAuthMethods ?? ['none']
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin)
    if (url.pathname.includes('.well-known/oauth-protected-resource')) {
      json(response, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['read'],
      })
      return
    }
    if (
      url.pathname === '/.well-known/oauth-authorization-server'
      || url.pathname === '/.well-known/openid-configuration'
    ) {
      json(response, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        ...(dynamicRegistration ? { registration_endpoint: `${origin}/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: tokenAuthMethods,
      })
      return
    }
    if (url.pathname === '/register' && request.method === 'POST') {
      void readBody(request).then((body) => {
        registrations++
        const metadata = JSON.parse(body) as Record<string, unknown>
        json(response, {
          ...metadata,
          client_id: 'dynamic-client',
          token_endpoint_auth_method: 'none',
        })
      })
      return
    }
    if (url.pathname === '/token' && request.method === 'POST') {
      void readBody(request).then((body) => {
        tokenExchanges++
        const params = new URLSearchParams(body)
        lastTokenRequest = params
        assert.equal(params.get('grant_type'), 'authorization_code')
        assert.equal(params.get('code'), 'accepted-code')
        assert.ok(params.get('code_verifier'))
        if (dynamicRegistration) assert.equal(params.get('client_id'), 'dynamic-client')
        json(response, {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          token_type: 'bearer',
          scope: 'read',
        })
      })
      return
    }
    response.writeHead(404).end()
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('OAuth 测试服务器未启动')
  origin = `http://127.0.0.1:${address.port}`
  return {
    server,
    origin,
    mcpUrl: `${origin}/mcp`,
    registrationCount: () => registrations,
    tokenExchangeCount: () => tokenExchanges,
    lastTokenRequest: () => lastTokenRequest,
  }
}

function httpConfig(
  url: string,
  extra: Partial<McpHttpServerConfig> = {},
): McpHttpServerConfig {
  return {
    name: 'remote',
    scope: 'global',
    sourceFingerprint: 'f'.repeat(64),
    runtimeFingerprint: 'e'.repeat(64),
    connectionFingerprint: 'a'.repeat(64),
    transport: 'http',
    url,
    headers: {},
    startupTimeoutMs: 10_000,
    toolTimeoutMs: 60_000,
    ...extra,
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法预留 OAuth 回调端口')
  const port = address.port
  await closeServer(server)
  return port
}

function json(response: ServerResponse, value: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) body += String(chunk)
  return body
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
