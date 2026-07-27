import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { McpHttpServerConfig } from '@whycode/core'
import type { McpOAuthController } from './mcp-oauth.ts'

// GitHub OAuth Apps 没有私有仓库只读 scope；工具写入能力仍由内置 X-MCP-Readonly 强制关闭。
const GITHUB_DEFAULT_SCOPE = 'repo read:org read:user'

export interface McpRegisteredOAuthClient {
  clientId: string
  clientSecret?: string
  scope?: string
  tokenEndpointAuthMethod?: 'client_secret_post'
}

export class DesktopMcpOAuthProvider implements OAuthClientProvider {
  private readonly controller: McpOAuthController
  private readonly config: McpHttpServerConfig
  private readonly interactive: boolean
  private clientInformationValue?: OAuthClientInformationMixed
  private tokenValue?: OAuthTokens
  private verifier?: string
  state?: () => string
  saveClientInformation?: (clientInformation: OAuthClientInformationMixed) => Promise<void>

  constructor(
    controller: McpOAuthController,
    config: McpHttpServerConfig,
    interactive: boolean,
    authorizationState?: string,
  ) {
    this.controller = controller
    this.config = config
    this.interactive = interactive
    const session = controller.currentSession(config)
    this.clientInformationValue = session?.clientInformation
    this.tokenValue = session?.tokens
    if (authorizationState) this.state = () => authorizationState
    if (interactive) {
      this.saveClientInformation = async (clientInformation) => {
        this.clientInformationValue = clientInformation
        await this.persist()
      }
    }
  }

  get redirectUrl(): URL {
    return this.controller.redirectUrl()
  }

  get clientMetadata(): OAuthClientMetadata {
    const registered = this.controller.registeredClient(this.config)
    return {
      redirect_uris: [this.redirectUrl.href],
      client_name: 'WhyCode',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(mcpAuthorizationScope(this.config, registered)
        ? { scope: mcpAuthorizationScope(this.config, registered) }
        : {}),
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.clientInformationValue) return this.clientInformationValue
    const registered = this.controller.registeredClient(this.config)
    return registered ? {
      client_id: registered.clientId,
      ...(registered.clientSecret ? { client_secret: registered.clientSecret } : {}),
      redirect_uris: [this.redirectUrl.href],
      client_name: 'WhyCode',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(registered.tokenEndpointAuthMethod
        ? { token_endpoint_auth_method: registered.tokenEndpointAuthMethod }
        : {}),
    } : undefined
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenValue ?? this.controller.currentSession(this.config)?.tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokenValue = tokens
    await this.persist()
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      throw new Error('MCP 服务器需要重新登录；请在“连接 → MCP 服务”中完成认证')
    }
    if (!safeMcpOAuthUrl(authorizationUrl)) {
      throw new Error('MCP OAuth 授权地址不安全，已拒绝打开')
    }
    await this.controller.openAuthorization(authorizationUrl)
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('MCP OAuth PKCE 校验状态缺失')
    return this.verifier
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    if (scope === 'discovery') return
    if (scope === 'all' || scope === 'tokens') this.tokenValue = undefined
    if (scope === 'all' || scope === 'client') this.clientInformationValue = undefined
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined
    if (scope !== 'verifier') await this.persist()
  }

  private async persist(): Promise<void> {
    const clientInformation = this.clientInformationValue ?? this.clientInformation()
    if (!clientInformation && !this.tokenValue) {
      await this.controller.disconnect(this.config)
      return
    }
    await this.controller.saveSession(this.config, {
      ...(clientInformation ? { clientInformation } : {}),
      ...(this.tokenValue ? { tokens: this.tokenValue } : {}),
    })
  }
}

export function mcpAuthorizationScope(
  config: McpHttpServerConfig,
  registered?: McpRegisteredOAuthClient,
): string | undefined {
  if (registered?.scope) return registered.scope
  return config.builtinId === 'github' ? GITHUB_DEFAULT_SCOPE : undefined
}

export function safeMcpOAuthUrl(url: URL): boolean {
  if (url.username || url.password) return false
  return url.protocol === 'https:'
    || (
      url.protocol === 'http:'
      && (
        url.hostname === '127.0.0.1'
        || url.hostname === '[::1]'
        || url.hostname === 'localhost'
      )
    )
}
