import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  CustomConnectionConfig,
  ProviderConnectionConfig,
  WhycodeConfig,
} from './config.ts'

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

interface StoredCustomConnection extends Omit<CustomConnectionConfig, 'apiKey'> {
  apiKey?: string
  encryptedApiKey?: string
}

interface StoredConfig {
  version?: number
  providers?: Record<string, StoredCredential>
  defaultModel?: string
  customConnections?: StoredCustomConnection[]
  consensusAgents?: Partial<Record<'B' | 'C', {
    model: string
    apiKey?: string
    encryptedApiKey?: string
    baseURL?: string
  }>>
}

export function getConfigPath(): string {
  return join(homedir(), '.whycode', 'config.json')
}

/** 同步读取保留现有调用语义；损坏项 fail-closed，不把密钥或无效连接送入运行时。 */
export function loadConfig(
  path = getConfigPath(),
  codec?: ConfigSecretCodec,
): WhycodeConfig | null {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf-8')) as StoredConfig
    if (!isRecord(stored.providers)) return null
    const providers = Object.create(null) as WhycodeConfig['providers']
    for (const [provider, value] of Object.entries(stored.providers)) {
      const credential = parseCredential(value, codec)
      if (credential) providers[provider] = credential
    }
    const customConnections = Array.isArray(stored.customConnections)
      ? stored.customConnections.flatMap((value) => {
          const connection = parseCustomConnection(value, codec)
          return connection ? [connection] : []
        })
      : undefined
    const consensusAgents = parseConsensusAgents(stored.consensusAgents, codec)
    return {
      providers,
      ...(typeof stored.defaultModel === 'string' ? { defaultModel: stored.defaultModel } : {}),
      ...(customConnections ? { customConnections } : {}),
      ...(consensusAgents ? { consensusAgents } : {}),
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
    version: 2,
    providers: Object.fromEntries(Object.entries(config.providers).map(([provider, value]) => [
      provider,
      storeCredential(value, codec),
    ])),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    ...(config.customConnections ? {
      customConnections: config.customConnections.map((connection) => ({
        ...connection,
        apiKey: undefined,
        encryptedApiKey: codec.encrypt(connection.apiKey),
      })),
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
  }
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

export async function migratePlaintextSecrets(
  codec: ConfigSecretCodec,
  path = getConfigPath(),
): Promise<boolean> {
  if (!codec.isAvailable()) return false
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch {
    return false
  }
  if (!/"apiKey"\s*:\s*"[^"]+"/.test(raw)) return false
  const config = loadConfig(path, codec)
  if (!config) return false
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

function parseCustomConnection(
  value: unknown,
  codec?: ConfigSecretCodec,
): CustomConnectionConfig | null {
  if (!isRecord(value)) return null
  const apiKey = readSecret(value, codec)
  const protocol = value.protocol
  if (
    apiKey === null
    || typeof value.id !== 'string'
    || typeof value.name !== 'string'
    || typeof value.baseURL !== 'string'
    || typeof value.modelId !== 'string'
    || !isCustomProtocol(protocol)
    || !isProbe(value.probe)
    || typeof value.checkedAt !== 'string'
  ) return null
  return {
    id: value.id,
    name: value.name,
    protocol,
    baseURL: value.baseURL,
    apiKey,
    modelId: value.modelId,
    probe: value.probe,
    ...(isStringRecord(value.probeDetails) ? { probeDetails: value.probeDetails } : {}),
    checkedAt: value.checkedAt,
  }
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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isCustomProtocol(value: unknown): value is CustomConnectionConfig['protocol'] {
  return value === 'anthropic-messages' || value === 'openai-chat' || value === 'openai-responses'
}

function isProbe(value: unknown): value is CustomConnectionConfig['probe'] {
  return isRecord(value)
    && isProbeState(value.text)
    && isProbeState(value.tools)
    && isProbeState(value.image)
}

function isProbeState(value: unknown): boolean {
  return value === 'supported' || value === 'unsupported' || value === 'unknown'
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
