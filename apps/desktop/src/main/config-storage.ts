import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BUILTIN_PROVIDERS } from '@whycode/core'
import {
  getCliProxyModelCompatibility,
  isCliProxyRoute,
} from './cli-proxy-models.ts'
import type { ProviderConnectionConfig, WhycodeConfig } from './config.ts'

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
  providers?: Record<string, StoredCredential>
  defaultModel?: string
  retiredModelLabels?: Record<string, string>
  cliProxyApi?: StoredCredential & {
    modelIds?: string[]
    modelRoutes?: Record<string, string>
  }
  consensusAgents?: Partial<Record<'B' | 'C', {
    model: string
    apiKey?: string
    encryptedApiKey?: string
    baseURL?: string
  }>>
  webSearch?: {
    perplexity?: StoredCredential
  }
  /** v3 兼容输入；只在启动迁移读取，永不进入运行时或再次保存。 */
  customConnections?: unknown
}

const CONFIG_VERSION = 5
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export function getConfigPath(): string {
  return join(homedir(), '.whycode', 'config.json')
}

/** 同步读取保留现有调用语义；损坏项 fail-closed，不把密钥送入 Renderer。 */
export function loadConfig(
  path = getConfigPath(),
  codec?: ConfigSecretCodec,
): WhycodeConfig | null {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as StoredConfig
    if (!isRecord(stored.providers)) return null
    const providers = Object.create(null) as WhycodeConfig['providers']
    for (const provider of BUILTIN_PROVIDERS) {
      const credential = parseCredential(stored.providers[provider.id], codec)
      if (credential) providers[provider.id] = credential
    }
    const retiredModelLabels = parseRetiredModelLabels(stored.retiredModelLabels)
    const cliProxyApi = parseCliProxyApi(stored.cliProxyApi, codec)
    const consensusAgents = parseConsensusAgents(stored.consensusAgents, codec)
    const perplexity = isRecord(stored.webSearch)
      ? parseCredential(stored.webSearch.perplexity, codec)
      : null
    return {
      providers,
      ...(typeof stored.defaultModel === 'string' ? { defaultModel: stored.defaultModel } : {}),
      ...(retiredModelLabels ? { retiredModelLabels } : {}),
      ...(cliProxyApi ? { cliProxyApi } : {}),
      ...(consensusAgents ? { consensusAgents } : {}),
      ...(perplexity ? { webSearch: { perplexity: { apiKey: perplexity.apiKey } } } : {}),
    }
  } catch {
    return null
  }
}

export async function saveConfig(
  config: WhycodeConfig,
  codec: ConfigSecretCodec,
  path = getConfigPath(),
): Promise<void> {
  if (!codec.isAvailable()) throw new Error('系统安全存储当前不可用，不能安全保存 API key')
  const stored: StoredConfig = {
    version: CONFIG_VERSION,
    providers: Object.fromEntries(Object.entries(config.providers).map(([provider, value]) => [
      provider,
      storeCredential(value, codec),
    ])),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
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
    ...(config.consensusAgents ? {
      consensusAgents: Object.fromEntries(
        Object.entries(config.consensusAgents).map(([id, agent]) => [id, agent && {
          ...agent,
          apiKey: undefined,
          encryptedApiKey: codec.encrypt(agent.apiKey),
        }]),
      ),
    } : {}),
    ...(config.webSearch?.perplexity ? {
      webSearch: {
        perplexity: storeCredential(config.webSearch.perplexity, codec),
      },
    } : {}),
  }
  await writeStoredConfig(stored, path)
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
  let raw: string
  let stored: StoredConfig
  try {
    raw = await readFile(path, 'utf-8')
    stored = JSON.parse(raw) as StoredConfig
  } catch {
    return false
  }
  if (!isRecord(stored.providers)) return false
  const hasLegacyConnections = Object.hasOwn(stored, 'customConnections')
  const hasPlaintextSecret = /"apiKey"\s*:\s*"[^"]+"/.test(raw)
  if (stored.version === CONFIG_VERSION && !hasLegacyConnections && !hasPlaintextSecret) {
    return false
  }

  const config = loadConfig(path, codec)
  if (!config) return false
  const migratedLabels = mergeLabels(
    legacyCustomModelLabels(stored.customConnections),
    stored.version === CONFIG_VERSION ? undefined : { 'openai:gpt-5.2': 'GPT-5.2' },
  )
  const retiredModelLabels = mergeLabels(migratedLabels, config.retiredModelLabels)
  if (retiredModelLabels) config.retiredModelLabels = retiredModelLabels
  if (config.defaultModel?.startsWith('custom:')) delete config.defaultModel
  await saveConfig(config, codec, path)
  return true
}

function parseCredential(value: unknown, codec?: ConfigSecretCodec): ProviderConnectionConfig | null {
  if (!isRecord(value)) return null
  const apiKey = readSecret(value, codec)
  if (apiKey === null) return null
  const baseURL = optionalString(value.baseURL)
  return { apiKey, ...(baseURL ? { baseURL } : {}) }
}

function parseConsensusAgents(
  value: unknown,
  codec?: ConfigSecretCodec,
): WhycodeConfig['consensusAgents'] {
  if (!isRecord(value)) return undefined
  const parsed: WhycodeConfig['consensusAgents'] = {}
  for (const id of ['B', 'C'] as const) {
    const candidate = value[id]
    if (!isRecord(candidate) || typeof candidate.model !== 'string') continue
    const apiKey = readSecret(candidate, codec)
    if (apiKey === null) continue
    const baseURL = optionalString(candidate.baseURL)
    parsed[id] = { model: candidate.model, apiKey, ...(baseURL ? { baseURL } : {}) }
  }
  return Object.keys(parsed).length > 0 ? parsed : undefined
}

function parseCliProxyApi(
  value: unknown,
  codec?: ConfigSecretCodec,
): WhycodeConfig['cliProxyApi'] {
  const credential = parseCredential(value, codec)
  if (!credential?.baseURL || !isRecord(value) || !Array.isArray(value.modelIds)) {
    return undefined
  }
  const modelIds = [...new Set(value.modelIds.filter(
    (modelId): modelId is string => (
      typeof modelId === 'string' && Boolean(getCliProxyModelCompatibility(modelId))
    ),
  ))]
  const modelRoutes: Record<string, string> = {}
  if (isRecord(value.modelRoutes)) {
    for (const modelId of modelIds) {
      const route = value.modelRoutes[modelId]
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

function storeCredential(value: ProviderConnectionConfig, codec: ConfigSecretCodec): StoredCredential {
  return {
    encryptedApiKey: codec.encrypt(value.apiKey),
    ...(value.baseURL ? { baseURL: value.baseURL } : {}),
  }
}

function readSecret(value: Record<string, unknown>, codec?: ConfigSecretCodec): string | null {
  // 允许高级用户在 JSON 中显式写入新 key；下次启动会立即迁移为加密字段。
  if (typeof value.apiKey === 'string' && value.apiKey.trim()) return value.apiKey.trim()
  if (typeof value.encryptedApiKey === 'string') {
    if (!codec) return null
    try {
      return codec.decrypt(value.encryptedApiKey)
    } catch {
      return null
    }
  }
  return typeof value.apiKey === 'string' ? '' : null
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
