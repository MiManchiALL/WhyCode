import {
  getModelEntry,
  MODEL_REGISTRY,
  type CustomApiProtocol,
  type CustomConnectionProbe,
} from '@whycode/core'

export interface ProviderConnectionConfig {
  apiKey: string
  baseURL?: string
}

export interface CustomConnectionConfig {
  id: string
  name: string
  protocol: CustomApiProtocol
  baseURL: string
  apiKey: string
  modelId: string
  probe: CustomConnectionProbe
  probeDetails?: Partial<Record<'text' | 'tools' | 'image', string>>
  checkedAt: string
}

export interface ConsensusAgentConfig {
  model: string
  apiKey: string
  baseURL?: string
}

export interface PerplexitySearchConfig {
  apiKey: string
}

export interface WebSearchConfig {
  perplexity?: PerplexitySearchConfig
}

export interface WhycodeConfig {
  providers: Record<string, ProviderConnectionConfig>
  defaultModel?: string
  customConnections?: CustomConnectionConfig[]
  consensusAgents?: Partial<Record<'B' | 'C', ConsensusAgentConfig>>
  webSearch?: WebSearchConfig
}

export {
  getConfigPath,
  loadConfig,
  migratePlaintextSecrets,
  saveConfig,
  type ConfigSecretCodec,
} from './config-storage.ts'

/** 配置指定的可用模型优先，否则按官方目录和自定义连接顺序回退。 */
export function resolveDefaultModelId(config: WhycodeConfig | null): string | null {
  if (config?.defaultModel && hasConfiguredKey(config, config.defaultModel)) {
    return config.defaultModel
  }
  const builtIn = MODEL_REGISTRY.find((model) => hasConfiguredKey(config, model.id))?.id
  if (builtIn) return builtIn
  const custom = config?.customConnections?.find((connection) =>
    customConnectionUsable(connection))
  return custom ? customModelId(custom.id) : null
}

export function customModelId(connectionId: string): string {
  return `custom:${connectionId}`
}

export function customConnectionId(modelId: string): string | null {
  return modelId.startsWith('custom:') && modelId.length > 'custom:'.length
    ? modelId.slice('custom:'.length)
    : null
}

export function consensusAgentsReady(config: WhycodeConfig | null): boolean {
  const agents = config?.consensusAgents
  if (!agents) return false
  return (['B', 'C'] as const).every((id) => Boolean(agents[id]?.apiKey && agents[id]?.model))
}

function hasConfiguredKey(config: WhycodeConfig | null, modelId: string): boolean {
  if (!config) return false
  const customId = customConnectionId(modelId)
  if (customId) {
    return Boolean(config.customConnections?.some((item) =>
      item.id === customId && customConnectionUsable(item)))
  }
  try {
    return Boolean(config.providers[getModelEntry(modelId).provider]?.apiKey)
  } catch {
    return false
  }
}

function customConnectionUsable(connection: CustomConnectionConfig): boolean {
  return Boolean(
    connection.apiKey
    && connection.probe.text === 'supported'
    && connection.probe.tools === 'supported',
  )
}
