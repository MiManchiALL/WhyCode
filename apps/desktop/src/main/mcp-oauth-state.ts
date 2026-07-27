import {
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

const CONNECTION_FINGERPRINT = /^[a-f0-9]{64}$/u
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export interface McpOAuthSession {
  serverName: string
  connectionFingerprint: string
  clientInformation?: OAuthClientInformationMixed
  tokens?: OAuthTokens
}

export function parseMcpOAuthSession(value: unknown): McpOAuthSession {
  if (!isRecord(value)) throw new Error('MCP OAuth 状态必须是对象')
  const serverName = boundedName(value.serverName)
  const connectionFingerprint = value.connectionFingerprint
  if (
    typeof connectionFingerprint !== 'string'
    || !CONNECTION_FINGERPRINT.test(connectionFingerprint)
  ) throw new Error('MCP OAuth 连接指纹无效')

  const clientInformation = value.clientInformation === undefined
    ? undefined
    : parseClientInformation(value.clientInformation)
  const tokens = value.tokens === undefined
    ? undefined
    : OAuthTokensSchema.parse(value.tokens)
  if (!clientInformation && !tokens) throw new Error('MCP OAuth 状态为空')
  return {
    serverName,
    connectionFingerprint,
    ...(clientInformation ? { clientInformation } : {}),
    ...(tokens ? { tokens } : {}),
  }
}

export function mcpOAuthSessionKey(
  value: Pick<McpOAuthSession, 'serverName' | 'connectionFingerprint'>,
): string {
  return `${value.serverName}\u0000${value.connectionFingerprint}`
}

function parseClientInformation(value: unknown): OAuthClientInformationMixed {
  const full = OAuthClientInformationFullSchema.safeParse(value)
  return full.success ? full.data : OAuthClientInformationSchema.parse(value)
}

function boundedName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MCP OAuth 服务器名称无效')
  const name = value.trim()
  if (!name || name.length > 128 || CONTROL_CHARACTER.test(name)) {
    throw new Error('MCP OAuth 服务器名称无效')
  }
  return name
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
