import {
  BUILTIN_PROVIDERS,
  MODEL_CATALOG,
  type BuiltInProviderId,
  type ProviderProtocol,
} from '@whycode/core'
import type {
  ConnectionSettingsSnapshot,
  McpSettingsItem,
  SaveAuxiliaryModelSettingsRequest,
  SaveCliProxyApiSettingsRequest,
  SaveConsensusModelSettingsRequest,
  SaveProviderSettingsRequest,
} from '../shared/settings.ts'
import {
  parseCliProxyModelId,
  type WhycodeConfig,
} from './config.ts'
import {
  cliProxyModelEntries,
  getCliProxyEffectiveCapabilities,
  getDefaultCliProxyRoute,
  isCliProxyRoute,
} from './cli-proxy-models.ts'
import { createWebSearchSettingsSnapshot } from './web-search-settings.ts'
import {
  listAuxiliaryVisionModelCandidates,
  listConfiguredModelCandidates,
} from './model-connections.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export function createConnectionSettingsSnapshot(
  config: WhycodeConfig | null,
  mcp: McpSettingsItem,
): ConnectionSettingsSnapshot {
  const cliProxyConnection = config?.cliProxyApi
  const cliProxyModels = cliProxyModelEntries().flatMap(({ entry }) => {
    const configuredRoute = cliProxyConnection?.modelRoutes[entry.id]
    const routeModelId = configuredRoute && isCliProxyRoute(entry.id, configuredRoute)
      ? configuredRoute
      : null
    if (cliProxyConnection?.apiKey && !routeModelId) return []
    const effectiveRouteModelId = routeModelId ?? getDefaultCliProxyRoute(entry.id)!
    return [{
      id: entry.id,
      displayName: entry.displayName,
      enabled: Boolean(cliProxyConnection?.modelIds.includes(entry.id)),
      capabilities: getCliProxyEffectiveCapabilities(entry.id, effectiveRouteModelId)!,
    }]
  })
  const auxiliaryVisionModels = listAuxiliaryVisionModelCandidates(config)
  const configuredAuxiliaryVisionModelId = config?.auxiliaryModels?.visionModelId
  const auxiliaryVisionModelId = auxiliaryVisionModels.some(
    (candidate) => candidate.id === configuredAuxiliaryVisionModelId,
  ) ? configuredAuxiliaryVisionModelId! : null
  const configuredModels = listConfiguredModelCandidates(config)
  const configuredSubagentModelId = config?.auxiliaryModels?.subagentModelId
  const configuredAgentBModelId = config?.consensusAgents?.B?.modelId
  const configuredAgentCModelId = config?.consensusAgents?.C?.modelId

  return {
    providers: BUILTIN_PROVIDERS.map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      protocolLabel: protocolLabel(provider.protocol),
      defaultBaseURL: provider.defaultBaseURL,
      ...(config?.providers[provider.id]?.baseURL
        ? { baseURL: config.providers[provider.id]!.baseURL }
        : {}),
      hasKey: Boolean(config?.providers[provider.id]?.apiKey),
      models: MODEL_CATALOG
        .filter((model) => model.provider === provider.id)
        .map((model) => ({
          id: model.id,
          displayName: model.displayName,
          capabilities: model.capabilities,
        })),
    })),
    cliProxyApi: {
      displayName: 'CLIProxyAPI',
      ...(config?.cliProxyApi?.baseURL ? { baseURL: config.cliProxyApi.baseURL } : {}),
      hasKey: Boolean(config?.cliProxyApi?.apiKey),
      models: cliProxyModels,
    },
    auxiliaryModels: {
      visionModelId: auxiliaryVisionModelId,
      subagentModelId: configuredModelId(configuredModels, configuredSubagentModelId),
      visionModels: auxiliaryVisionModels,
      subagentModels: configuredModels,
    },
    consensusModels: {
      agentBModelId: configuredModelId(configuredModels, configuredAgentBModelId),
      agentCModelId: configuredModelId(configuredModels, configuredAgentCModelId),
      models: configuredModels,
    },
    webSearch: createWebSearchSettingsSnapshot(config),
    mcp,
  }
}

export function updateConsensusModelSettings(
  config: WhycodeConfig | null,
  request: SaveConsensusModelSettingsRequest,
): WhycodeConfig {
  const next = cloneConfig(config)
  const candidates = listConfiguredModelCandidates(next)
  const selections = {
    B: normalizeConfiguredModelSelection(candidates, request.agentBModelId),
    C: normalizeConfiguredModelSelection(candidates, request.agentCModelId),
  } as const
  const agents: WhycodeConfig['consensusAgents'] = {}
  for (const id of ['B', 'C'] as const) {
    const modelId = selections[id]
    if (modelId) agents[id] = { modelId }
  }
  if (Object.keys(agents).length > 0) next.consensusAgents = agents
  else delete next.consensusAgents
  return next
}

export function updateAuxiliaryModelSettings(
  config: WhycodeConfig | null,
  request: SaveAuxiliaryModelSettingsRequest,
): WhycodeConfig {
  const next = cloneConfig(config)
  const visionModelId = request.visionModelId === null
    ? null
    : request.visionModelId.trim()
  if (visionModelId) {
    if (!listAuxiliaryVisionModelCandidates(next).some(
      (candidate) => candidate.id === visionModelId,
    )) {
      throw new Error('视觉辅助模型必须是当前已配置且可用的多模态模型')
    }
  } else if (request.visionModelId !== null) {
    throw new Error('视觉辅助模型 ID 不能为空')
  }
  const subagentModelId = normalizeConfiguredModelSelection(
    listConfiguredModelCandidates(next),
    request.subagentModelId,
    '子代理模型',
  )
  if (visionModelId || subagentModelId) {
    next.auxiliaryModels = {
      ...(visionModelId ? { visionModelId } : {}),
      ...(subagentModelId ? { subagentModelId } : {}),
    }
  } else {
    delete next.auxiliaryModels
  }
  return next
}

export function updateProviderSettings(
  config: WhycodeConfig | null,
  request: SaveProviderSettingsRequest,
): WhycodeConfig {
  requireBuiltInProvider(request.providerId)
  const next = cloneConfig(config)
  const previous = next.providers[request.providerId]
  const suppliedKey = request.apiKey?.trim()
  const apiKey = request.clearApiKey ? '' : suppliedKey || previous?.apiKey || ''
  const baseURL = normalizeOptionalBaseURL(request.baseURL)
  if (!apiKey && !baseURL) {
    delete next.providers[request.providerId]
  } else {
    next.providers[request.providerId] = { apiKey, ...(baseURL ? { baseURL } : {}) }
  }
  if (request.clearApiKey && next.defaultModel?.startsWith(`${request.providerId}:`)) {
    delete next.defaultModel
  }
  return next
}

export function updateCliProxyApiSettings(
  config: WhycodeConfig | null,
  request: SaveCliProxyApiSettingsRequest,
): WhycodeConfig {
  const requestedIds = new Set(request.modelIds)
  if (requestedIds.size === 0) throw new Error('请至少选择一个 CLIProxyAPI 模型')
  if (requestedIds.size !== request.modelIds.length) throw new Error('CLIProxyAPI 模型不能重复')
  const modelIds = cliProxyModelEntries()
    .filter(({ entry }) => requestedIds.has(entry.id))
    .map(({ entry }) => entry.id)
  if (modelIds.length !== requestedIds.size) {
    throw new Error('CLIProxyAPI 只能选择已确认存在等价路由的 WhyCode 模型')
  }

  const next = cloneConfig(config)
  const suppliedKey = request.apiKey?.trim()
  const apiKey = request.clearApiKey
    ? ''
    : suppliedKey || next.cliProxyApi?.apiKey || ''
  next.cliProxyApi = {
    apiKey,
    baseURL: normalizeRequiredBaseURL(request.baseURL),
    modelIds,
    // 精确路由只能来自当前实例鉴权后的 /models，不能在纯设置转换层猜测。
    modelRoutes: {},
  }
  const defaultCliProxyModelId = next.defaultModel
    ? parseCliProxyModelId(next.defaultModel)
    : null
  if (
    defaultCliProxyModelId
    && (request.clearApiKey || !modelIds.includes(defaultCliProxyModelId))
  ) {
    delete next.defaultModel
  }
  return next
}

function cloneConfig(config: WhycodeConfig | null): WhycodeConfig {
  return config ? structuredClone(config) : { providers: {} }
}

function configuredModelId(
  models: readonly { id: string }[],
  modelId: string | undefined,
): string | null {
  return modelId && models.some((model) => model.id === modelId) ? modelId : null
}

function normalizeConfiguredModelSelection(
  models: readonly { id: string }[],
  value: string | null,
  label = '协商评审模型',
): string | null {
  if (value === null) return null
  const modelId = value.trim()
  if (!modelId) return null
  if (!models.some((model) => model.id === modelId)) {
    throw new Error(`${label}必须来自当前已配置且可用的模型连接`)
  }
  return modelId
}

function requireBuiltInProvider(providerId: BuiltInProviderId): void {
  if (!BUILTIN_PROVIDERS.some((provider) => provider.id === providerId)) {
    throw new Error('未知的内置模型厂商')
  }
}

function normalizeOptionalBaseURL(value: string | undefined): string | undefined {
  return value?.trim() ? normalizeRequiredBaseURL(value) : undefined
}

function normalizeRequiredBaseURL(value: string): string {
  const trimmed = value.trim()
  if (CONTROL_CHARACTER.test(trimmed)) throw new Error('Base URL 不能包含控制字符')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Base URL 不是有效网址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Base URL 只允许 http 或 https')
  }
  if (url.username || url.password) throw new Error('Base URL 不能包含用户名或密码')
  return url.toString().replace(/\/$/, '')
}

function protocolLabel(protocol: ProviderProtocol): string {
  if (protocol === 'anthropic-messages') return 'Anthropic Messages'
  if (protocol === 'openai-responses') return 'OpenAI Responses'
  return 'OpenAI Chat Completions'
}
