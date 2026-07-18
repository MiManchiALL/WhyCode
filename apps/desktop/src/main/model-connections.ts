import {
  createCustomModelEntry,
  getBuiltInProvider,
  getModelEntry,
  MODEL_REGISTRY,
  type ModelEntry,
  type ProviderConfig,
} from '@whycode/core'
import {
  customConnectionId,
  customModelId,
  type CustomConnectionConfig,
  type WhycodeConfig,
} from './config.ts'

export interface ResolvedModelConnection {
  entry: ModelEntry
  providerConfig: ProviderConfig
  custom: boolean
}

export type ModelConnectionResolution =
  | { ok: true; value: ResolvedModelConnection }
  | { ok: false; error: string }

export interface ModelConnectionListItem {
  id: string
  displayName: string
  hasKey: boolean
  available: boolean
  unavailableReason?: string
  supportsImageInput: boolean
  custom: boolean
}

export function resolveModelConnection(
  config: WhycodeConfig | null,
  modelId: string,
): ModelConnectionResolution {
  if (!config) return { ok: false, error: '尚未配置任何模型' }
  const connectionId = customConnectionId(modelId)
  if (connectionId) return resolveCustomConnection(config, connectionId)

  let entry: ModelEntry
  try {
    entry = getModelEntry(modelId)
  } catch {
    return { ok: false, error: `模型 ID 未注册：${modelId}` }
  }
  const providerConfig = config.providers[entry.provider]
  if (!providerConfig?.apiKey) {
    return { ok: false, error: `尚未配置 ${entry.provider} 的 API key，无法使用 ${entry.displayName}` }
  }
  return {
    ok: true,
    value: {
      entry: applyEndpointOverride(entry, providerConfig.baseURL),
      providerConfig,
      custom: false,
    },
  }
}

export function listModelConnections(config: WhycodeConfig | null): ModelConnectionListItem[] {
  const builtIn = MODEL_REGISTRY.map((entry) => {
    const result = resolveModelConnection(config, entry.id)
    const effective = result.ok ? result.value.entry : entry
    return {
      id: entry.id,
      displayName: entry.displayName,
      hasKey: Boolean(config?.providers[entry.provider]?.apiKey),
      available: result.ok,
      ...(!result.ok ? { unavailableReason: result.error } : {}),
      supportsImageInput: effective.capabilities.supportsImageInput,
      custom: false,
    }
  })
  const custom = (config?.customConnections ?? []).map((connection) => {
    const result = resolveCustomConnection(config!, connection.id)
    const entry = customEntry(connection)
    return {
      id: customModelId(connection.id),
      displayName: connection.name,
      hasKey: Boolean(connection.apiKey),
      available: result.ok,
      ...(!result.ok ? { unavailableReason: result.error } : {}),
      supportsImageInput: entry.capabilities.supportsImageInput,
      custom: true,
    }
  })
  return [...builtIn, ...custom]
}

function resolveCustomConnection(
  config: WhycodeConfig,
  connectionId: string,
): ModelConnectionResolution {
  const connection = config.customConnections?.find((item) => item.id === connectionId)
  if (!connection) return { ok: false, error: '自定义连接不存在' }
  if (!connection.apiKey) return { ok: false, error: `${connection.name} 尚未配置 API key` }
  if (connection.probe.text !== 'supported') {
    return { ok: false, error: `${connection.name} 尚未通过文本连接检测` }
  }
  if (connection.probe.tools !== 'supported') {
    return { ok: false, error: `${connection.name} 尚未通过工具调用检测，不能作为完整 Agent 使用` }
  }
  return {
    ok: true,
    value: {
      entry: customEntry(connection),
      providerConfig: { apiKey: connection.apiKey, baseURL: connection.baseURL },
      custom: true,
    },
  }
}

function customEntry(connection: CustomConnectionConfig): ModelEntry {
  return createCustomModelEntry({
    id: customModelId(connection.id),
    connectionName: connection.name,
    protocol: connection.protocol,
    modelId: connection.modelId,
    probe: connection.probe,
  })
}

/** 非官方端点没有探测记录时，不继承官方模型的图片传输能力。 */
function applyEndpointOverride(entry: ModelEntry, baseURL?: string): ModelEntry {
  if (!baseURL || entry.provider === 'custom') return entry
  const official = getBuiltInProvider(entry.provider)
  if (normalizeBaseURL(baseURL) === normalizeBaseURL(official.defaultBaseURL)) return entry
  return {
    ...entry,
    capabilities: {
      ...entry.capabilities,
      supportsImageInput: false,
      supportsOriginalImageDetail: undefined,
    },
  }
}

function normalizeBaseURL(value: string): string {
  return value.trim().replace(/\/+$/, '').toLowerCase()
}
