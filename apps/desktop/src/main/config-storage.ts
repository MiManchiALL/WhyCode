import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BUILTIN_PROVIDERS,
  parseMcpSecretHeader,
  type McpSecretHeader,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'
import {
  getCliProxyModelCompatibility,
  isCliProxyRoute,
} from './cli-proxy-models.ts'
import type {
  TavilySearchDepth,
  WebSearchProviderId,
} from '../shared/settings.ts'
import type { ProviderConnectionConfig, WhycodeConfig } from './config.ts'
import {
  mcpOAuthSessionKey,
  parseMcpOAuthSession,
  type McpOAuthSession,
} from './mcp-oauth-state.ts'

export interface ConfigSecretCodec {
  isAvailable(): boolean
  encrypt(secret: string): string
  decrypt(payload: string): string
}

interface StoredCredential {
  apiKey?: string
  encryptedApiKey?: string
  baseURL?: string
}

interface StoredConfig {
  version?: number
  providers: Record<string, StoredCredential>
  defaultModel?: string
  permissionMode?: unknown
  retiredModelLabels?: Record<string, string>
  cliProxyApi?: StoredCredential & {
    modelIds?: string[]
    modelRoutes?: Record<string, string>
  }
  auxiliaryModels?: {
    visionModelId?: unknown
    subagentModelId?: unknown
  }
  consensusAgents?: Partial<Record<'B' | 'C', {
    modelId?: unknown
  }>>
  webSearch?: {
    activeProvider?: string
    perplexity?: StoredCredential
    tavily?: StoredCredential & { searchDepth?: string }
  }
  mcpSecretHeaders?: Array<{
    serverName?: unknown
    connectionFingerprint?: unknown
    headerName?: unknown
    encryptedValue?: unknown
  }>
  mcpOAuthSessions?: Array<{
    serverName?: unknown
    connectionFingerprint?: unknown
    encryptedPayload?: unknown
  }>
  /** v3 兼容输入；只在启动迁移读取，永不进入运行时或再次保存。 */
  customConnections?: unknown
}

const CONFIG_VERSION = 10
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export class ConfigReadError extends Error {
  constructor(reason: string) {
    super(`WhyCode 配置读取失败：${reason}。原文件已保留，请检查配置文件或系统安全存储。`)
    this.name = 'ConfigReadError'
  }
}

export function getConfigPath(): string {
  return join(homedir(), '.whycode', 'config.json')
}

/** 只有文件不存在表示尚未配置；读取失败不能成为下一次写入的空配置。 */
export function loadConfig(
  path = getConfigPath(),
  codec?: ConfigSecretCodec,
): WhycodeConfig | null {
  const stored = readStoredConfig(path)
  if (!stored) return null
  const providers = Object.create(null) as WhycodeConfig['providers']
  for (const provider of BUILTIN_PROVIDERS) {
    const credential = parseCredential(stored.providers[provider.id], codec)
    if (credential) providers[provider.id] = credential
  }
  const retiredModelLabels = parseRetiredModelLabels(stored.retiredModelLabels)
  const cliProxyApi = parseCliProxyApi(stored.cliProxyApi, codec)
  const auxiliaryModels = parseAuxiliaryModels(stored.auxiliaryModels)
  const consensusAgents = parseConsensusAgents(stored.consensusAgents)
  const webSearch = parseWebSearch(stored.webSearch, codec)
  const mcpSecretHeaders = parseStoredMcpSecretHeaders(stored.mcpSecretHeaders, codec)
  const mcpOAuthSessions = parseStoredMcpOAuthSessions(stored.mcpOAuthSessions, codec)
  const permissionMode = parsePermissionMode(stored.permissionMode)
  return {
    providers,
    ...(typeof stored.defaultModel === 'string' ? { defaultModel: stored.defaultModel } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(retiredModelLabels ? { retiredModelLabels } : {}),
    ...(cliProxyApi ? { cliProxyApi } : {}),
    ...(auxiliaryModels ? { auxiliaryModels } : {}),
    ...(consensusAgents ? { consensusAgents } : {}),
    ...(webSearch ? { webSearch } : {}),
    ...(mcpSecretHeaders ? { mcpSecretHeaders } : {}),
    ...(mcpOAuthSessions ? { mcpOAuthSessions } : {}),
  }
}

function readStoredConfig(path: string): (Record<string, unknown> & {
  providers: Record<string, unknown>
}) | null {
  try {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!isRecord(stored) || !isRecord(stored.providers)) throw new ConfigReadError('格式无效')
    return { ...stored, providers: stored.providers }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return null
    if (error instanceof ConfigReadError) throw error
    throw new ConfigReadError(error instanceof SyntaxError ? '格式无效' : '无法读取')
  }
}

export async function saveConfig(
  config: WhycodeConfig,
  codec: ConfigSecretCodec,
  path = getConfigPath(),
): Promise<void> {
  if (!codec.isAvailable()) throw new Error('系统安全存储当前不可用，不能安全保存 API key')
  // 写入边界重新确认原文件可完整读取，保护持有旧快照或直接保存的调用方。
  loadConfig(path, codec)
  const stored: StoredConfig = {
    version: CONFIG_VERSION,
    providers: Object.fromEntries(Object.entries(config.providers).map(([provider, value]) => [
      provider,
      storeCredential(value, codec),
    ])),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    ...(config.permissionMode ? { permissionMode: config.permissionMode } : {}),
    ...(config.retiredModelLabels
      ? { retiredModelLabels: config.retiredModelLabels }
      : {}),
    ...(config.cliProxyApi ? {
      cliProxyApi: {
        ...storeCredential(config.cliProxyApi, codec),
        modelIds: config.cliProxyApi.modelIds,
        modelRoutes: config.cliProxyApi.modelRoutes,
      },
    } : {}),
    ...(config.auxiliaryModels ? {
      auxiliaryModels: {
        ...(config.auxiliaryModels.visionModelId
          ? { visionModelId: config.auxiliaryModels.visionModelId }
          : {}),
        ...(config.auxiliaryModels.subagentModelId
          ? { subagentModelId: config.auxiliaryModels.subagentModelId }
          : {}),
      },
    } : {}),
    ...(config.consensusAgents ? {
      consensusAgents: Object.fromEntries(
        Object.entries(config.consensusAgents).map(([id, agent]) => [id, agent && {
          modelId: agent.modelId,
        }]),
      ),
    } : {}),
    ...(config.webSearch ? {
      webSearch: {
        ...(config.webSearch.activeProvider
          ? { activeProvider: config.webSearch.activeProvider }
          : {}),
        ...(config.webSearch.perplexity
          ? { perplexity: storeCredential(config.webSearch.perplexity, codec) }
          : {}),
        ...(config.webSearch.tavily
          ? {
              tavily: {
                ...storeCredential(config.webSearch.tavily, codec),
                searchDepth: config.webSearch.tavily.searchDepth ?? 'basic',
              },
            }
          : {}),
      },
    } : {}),
    ...(config.mcpSecretHeaders?.length ? {
      mcpSecretHeaders: storeMcpSecretHeaders(config.mcpSecretHeaders, codec),
    } : {}),
    ...(config.mcpOAuthSessions?.length ? {
      mcpOAuthSessions: storeMcpOAuthSessions(config.mcpOAuthSessions, codec),
    } : {}),
  }
  await writeStoredConfig(stored, path)
}

function parseAuxiliaryModels(value: unknown): WhycodeConfig['auxiliaryModels'] {
  if (!isRecord(value)) return undefined
  const visionModelId = safeLabel(value.visionModelId, 300)
  const subagentModelId = safeLabel(value.subagentModelId, 300)
  return visionModelId || subagentModelId
    ? {
        ...(visionModelId ? { visionModelId } : {}),
        ...(subagentModelId ? { subagentModelId } : {}),
      }
    : undefined
}

function parsePermissionMode(value: unknown): PermissionMode | undefined {
  return value === 'readonly'
    || value === 'default'
    || value === 'acceptEdits'
    || value === 'auto'
    ? value
    : undefined
}

/**
 * 一次性迁移旧版明文密钥、自定义连接和缺少实例路由的 CLIProxyAPI 配置。
 * 旧连接只留下“历史模型 ID → 展示名”，不会再成为可解析的模型连接。
 */
export async function migrateLegacyConfig(
  codec: ConfigSecretCodec,
  path = getConfigPath(),
): Promise<boolean> {
  if (!codec.isAvailable()) return false
  const stored = readStoredConfig(path)
  if (!stored) return false
  const hasLegacyConnections = Object.hasOwn(stored, 'customConnections')
  const hasPlaintextSecret = /"apiKey"\s*:\s*"[^"]+"/.test(JSON.stringify(stored))
  if (stored.version === CONFIG_VERSION && !hasLegacyConnections && !hasPlaintextSecret) {
    return false
  }

  const config = loadConfig(path, codec)
  if (!config) return false
  const migratedLabels = mergeLabels(
    legacyCustomModelLabels(stored.customConnections),
    config.retiredModelLabels,
  )
  if (migratedLabels) config.retiredModelLabels = migratedLabels
  if (config.defaultModel?.startsWith('custom:')) delete config.defaultModel
  await saveConfig(config, codec, path)
  return true
}

function parseCredential(value: unknown, codec?: ConfigSecretCodec): ProviderConnectionConfig | null {
  if (value === undefined) return null
  if (!isRecord(value)) throw new ConfigReadError('凭据格式无效')
  const apiKey = readSecret(value, codec)
  const baseURL = optionalString(value.baseURL)
  return { apiKey, ...(baseURL ? { baseURL } : {}) }
}

function parseConsensusAgents(
  value: unknown,
): WhycodeConfig['consensusAgents'] {
  if (!isRecord(value)) return undefined
  const parsed: WhycodeConfig['consensusAgents'] = {}
  for (const id of ['B', 'C'] as const) {
    const candidate = value[id]
    if (!isRecord(candidate)) continue
    const modelId = safeLabel(candidate.modelId, 300)
    if (modelId) parsed[id] = { modelId }
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

function parseWebSearch(
  value: unknown,
  codec?: ConfigSecretCodec,
): WhycodeConfig['webSearch'] {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ConfigReadError('搜索配置格式无效')
  const parsedPerplexity = parseCredential(value.perplexity, codec)
  const parsedTavily = parseCredential(value.tavily, codec)
  const perplexity = parsedPerplexity?.apiKey ? parsedPerplexity : null
  const tavily = parsedTavily?.apiKey ? parsedTavily : null
  if (!perplexity && !tavily) return undefined

  const requested = webSearchProviderId(value.activeProvider)
  const activeProvider = requested && (requested === 'perplexity' ? perplexity : tavily)
    ? requested
    : perplexity
      ? 'perplexity'
      : 'tavily'
  return {
    activeProvider,
    ...(perplexity ? { perplexity: { apiKey: perplexity.apiKey } } : {}),
    ...(tavily ? {
      tavily: {
        apiKey: tavily.apiKey,
        searchDepth: parseTavilySearchDepth(value.tavily),
      },
    } : {}),
  }
}

function parseStoredMcpSecretHeaders(
  value: unknown,
  codec?: ConfigSecretCodec,
): McpSecretHeader[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ConfigReadError('MCP 密钥格式无效')
  const parsed = new Map<string, McpSecretHeader>()
  for (const candidate of value) {
    if (
      !isRecord(candidate)
      || typeof candidate.serverName !== 'string'
      || typeof candidate.connectionFingerprint !== 'string'
      || typeof candidate.headerName !== 'string'
      || typeof candidate.encryptedValue !== 'string'
    ) throw new ConfigReadError('MCP 密钥格式无效')
    try {
      const entry = parseMcpSecretHeader({
        serverName: candidate.serverName,
        connectionFingerprint: candidate.connectionFingerprint,
        headerName: candidate.headerName,
        value: decryptSecret(candidate.encryptedValue, codec),
      })
      parsed.set(mcpSecretHeaderKey(entry), entry)
    } catch {
      throw new ConfigReadError('MCP 密钥无法读取')
    }
  }
  return parsed.size > 0 ? [...parsed.values()] : undefined
}

function storeMcpSecretHeaders(
  values: readonly McpSecretHeader[],
  codec: ConfigSecretCodec,
): NonNullable<StoredConfig['mcpSecretHeaders']> {
  const parsed = new Map<string, McpSecretHeader>()
  for (const value of values) {
    const entry = parseMcpSecretHeader(value)
    parsed.set(mcpSecretHeaderKey(entry), entry)
  }
  return [...parsed.values()]
    .sort((left, right) =>
      left.serverName.localeCompare(right.serverName)
      || left.connectionFingerprint.localeCompare(right.connectionFingerprint)
      || left.headerName.localeCompare(right.headerName))
    .map((entry) => ({
      serverName: entry.serverName,
      connectionFingerprint: entry.connectionFingerprint,
      headerName: entry.headerName,
      encryptedValue: codec.encrypt(entry.value),
    }))
}

function parseStoredMcpOAuthSessions(
  value: unknown,
  codec?: ConfigSecretCodec,
): McpOAuthSession[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ConfigReadError('MCP OAuth 状态格式无效')
  const parsed = new Map<string, McpOAuthSession>()
  for (const candidate of value) {
    if (
      !isRecord(candidate)
      || typeof candidate.serverName !== 'string'
      || typeof candidate.connectionFingerprint !== 'string'
      || typeof candidate.encryptedPayload !== 'string'
    ) throw new ConfigReadError('MCP OAuth 状态格式无效')
    try {
      const payload = JSON.parse(decryptSecret(candidate.encryptedPayload, codec)) as unknown
      const entry = parseMcpOAuthSession({
        serverName: candidate.serverName,
        connectionFingerprint: candidate.connectionFingerprint,
        ...(isRecord(payload) ? payload : {}),
      })
      parsed.set(mcpOAuthSessionKey(entry), entry)
    } catch {
      throw new ConfigReadError('MCP OAuth 状态无法读取')
    }
  }
  return parsed.size > 0 ? [...parsed.values()] : undefined
}

function storeMcpOAuthSessions(
  values: readonly McpOAuthSession[],
  codec: ConfigSecretCodec,
): NonNullable<StoredConfig['mcpOAuthSessions']> {
  const parsed = new Map<string, McpOAuthSession>()
  for (const value of values) {
    const entry = parseMcpOAuthSession(value)
    parsed.set(mcpOAuthSessionKey(entry), entry)
  }
  return [...parsed.values()]
    .sort((left, right) =>
      left.serverName.localeCompare(right.serverName)
      || left.connectionFingerprint.localeCompare(right.connectionFingerprint))
    .map(({ serverName, connectionFingerprint, clientInformation, tokens }) => ({
      serverName,
      connectionFingerprint,
      encryptedPayload: codec.encrypt(JSON.stringify({
        ...(clientInformation ? { clientInformation } : {}),
        ...(tokens ? { tokens } : {}),
      })),
    }))
}

function mcpSecretHeaderKey(entry: McpSecretHeader): string {
  return [
    entry.serverName,
    entry.connectionFingerprint,
    entry.headerName.toLowerCase(),
  ].join('\u0000')
}

function parseTavilySearchDepth(value: unknown): TavilySearchDepth {
  if (!isRecord(value)) return 'basic'
  return value.searchDepth === 'advanced' ? 'advanced' : 'basic'
}

function parseCliProxyApi(
  value: unknown,
  codec?: ConfigSecretCodec,
): WhycodeConfig['cliProxyApi'] {
  if (value === undefined) return undefined
  const credential = parseCredential(value, codec)
  if (!credential?.baseURL || !isRecord(value) || !Array.isArray(value.modelIds)) {
    throw new ConfigReadError('CLIProxyAPI 配置格式无效')
  }
  const modelIds = [...new Set(value.modelIds.filter(
    (modelId): modelId is string => (
      typeof modelId === 'string' && Boolean(getCliProxyModelCompatibility(modelId))
    ),
  ))]
  const modelRoutes: Record<string, string> = {}
  if (isRecord(value.modelRoutes)) {
    for (const [modelId, route] of Object.entries(value.modelRoutes)) {
      if (typeof route === 'string' && isCliProxyRoute(modelId, route)) {
        modelRoutes[modelId] = route
      }
    }
  }
  return {
    apiKey: credential.apiKey,
    baseURL: credential.baseURL,
    modelIds,
    modelRoutes,
  }
}

function parseRetiredModelLabels(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const labels = Object.create(null) as Record<string, string>
  for (const [modelId, label] of Object.entries(value)) {
    const normalizedId = safeLabel(modelId, 300)
    const normalizedLabel = safeLabel(label, 200)
    if (normalizedId && normalizedLabel) labels[normalizedId] = normalizedLabel
  }
  return Object.keys(labels).length > 0 ? labels : undefined
}

function legacyCustomModelLabels(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) return undefined
  const labels = Object.create(null) as Record<string, string>
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const id = safeLabel(candidate.id, 200)
    const label = safeLabel(candidate.modelId, 200) ?? safeLabel(candidate.name, 200)
    if (id && label) labels[`custom:${id}`] = label
  }
  return Object.keys(labels).length > 0 ? labels : undefined
}

function mergeLabels(
  first: Record<string, string> | undefined,
  second: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!first && !second) return undefined
  return Object.assign(Object.create(null), first, second) as Record<string, string>
}

function safeLabel(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength && !CONTROL_CHARACTER.test(trimmed)
    ? trimmed
    : undefined
}

function webSearchProviderId(value: unknown): WebSearchProviderId | undefined {
  return value === 'perplexity' || value === 'tavily' ? value : undefined
}

function storeCredential(value: ProviderConnectionConfig, codec: ConfigSecretCodec): StoredCredential {
  return {
    encryptedApiKey: codec.encrypt(value.apiKey),
    ...(value.baseURL ? { baseURL: value.baseURL } : {}),
  }
}

function readSecret(value: Record<string, unknown>, codec?: ConfigSecretCodec): string {
  // 允许高级用户在 JSON 中显式写入新 key；下次启动会立即迁移为加密字段。
  if (typeof value.apiKey === 'string' && value.apiKey.trim()) return value.apiKey.trim()
  if (typeof value.encryptedApiKey === 'string') {
    return decryptSecret(value.encryptedApiKey, codec)
  }
  if (typeof value.apiKey === 'string') return ''
  throw new ConfigReadError('凭据格式无效')
}

function decryptSecret(payload: string, codec?: ConfigSecretCodec): string {
  if (!codec?.isAvailable()) throw new ConfigReadError('密钥无法解密')
  try {
    return codec.decrypt(payload)
  } catch {
    throw new ConfigReadError('密钥无法解密')
  }
}

async function writeStoredConfig(stored: StoredConfig, path: string): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = join(directory, `.config-${randomUUID()}.tmp`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    })
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {})
    throw error
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
