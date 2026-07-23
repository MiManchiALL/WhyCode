import {
  getModelEntry,
  MODEL_REGISTRY,
  type ModelEntry,
  type ProviderConfig,
  type ReasoningEffortCapability,
} from '@whycode/core'
import {
  cliProxyModelId,
  parseCliProxyModelId,
  type WhycodeConfig,
} from './config.ts'
import {
  getCliProxyEffectiveCapabilities,
  getCliProxyModelCompatibility,
  getDefaultCliProxyRoute,
  isCliProxyRoute,
} from './cli-proxy-models.ts'

export interface ResolvedModelConnection {
  entry: ModelEntry
  providerConfig: ProviderConfig
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
  reasoningEffort?: ReasoningEffortCapability
  retired: boolean
}

export function resolveModelConnection(
  config: WhycodeConfig | null,
  modelId: string,
): ModelConnectionResolution {
  const cliProxyBaseId = parseCliProxyModelId(modelId)
  if (cliProxyBaseId) return resolveCliProxyConnection(config, cliProxyBaseId)

  let entry: ModelEntry
  try {
    entry = getModelEntry(modelId)
  } catch {
    return unsupportedModel(modelId)
  }
  if (!config) return { ok: false, error: '尚未配置任何模型' }
  const providerConfig = config.providers[entry.provider]
  if (!providerConfig?.apiKey) {
    return { ok: false, error: `尚未配置 ${entry.provider} 的 API key，无法使用 ${entry.displayName}` }
  }
  return { ok: true, value: { entry, providerConfig } }
}

export function listModelConnections(
  config: WhycodeConfig | null,
  selectedModelId?: string | null,
): ModelConnectionListItem[] {
  const builtIn = MODEL_REGISTRY.flatMap((entry) => {
    if (!config?.providers[entry.provider]?.apiKey) return []
    return [listItem(entry, resolveModelConnection(config, entry.id), true)]
  })
  const cliProxy = (config?.cliProxyApi?.modelIds ?? []).flatMap((baseModelId) => {
    const routeModelId = configuredCliProxyRoute(config, baseModelId)
    if (!config?.cliProxyApi?.apiKey || !routeModelId) return []
    try {
      const id = cliProxyModelId(baseModelId)
      return [listItem(
        cliProxyEntry(getModelEntry(baseModelId), routeModelId),
        resolveModelConnection(config, id),
        true,
      )]
    } catch {
      return []
    }
  })
  const current = [...builtIn, ...cliProxy]
  if (!selectedModelId || current.some((item) => item.id === selectedModelId)) return current

  const cliProxyBaseId = parseCliProxyModelId(selectedModelId)
  if (cliProxyBaseId) {
    const compatibility = getCliProxyModelCompatibility(cliProxyBaseId)
    try {
      const baseEntry = getModelEntry(cliProxyBaseId)
      if (compatibility) {
        const route = configuredCliProxyRoute(config, cliProxyBaseId)
          ?? getDefaultCliProxyRoute(cliProxyBaseId)!
        return [
          ...current,
          listItem(
            cliProxyEntry(baseEntry, route),
            resolveModelConnection(config, selectedModelId),
            false,
          ),
        ]
      }
      return [
        ...current,
        retiredListItem(
          selectedModelId,
          `${baseEntry.displayName}（CLIProxyAPI）`,
          `CLIProxyAPI 尚未适配 ${baseEntry.displayName}`,
        ),
      ]
    } catch {
      // 已退役的 CLIProxyAPI 型号继续走下方通用历史占位。
    }
  } else {
    try {
      const entry = getModelEntry(selectedModelId)
      return [
        ...current,
        listItem(entry, resolveModelConnection(config, selectedModelId), false),
      ]
    } catch {
      // 已退役的内置型号继续走下方通用历史占位。
    }
  }

  const resolution = resolveModelConnection(config, selectedModelId)
  return [
    ...current,
    retiredListItem(
      selectedModelId,
      config?.retiredModelLabels?.[selectedModelId] ?? selectedModelId,
      resolution.ok ? '当前模型未出现在连接列表中' : resolution.error,
    ),
  ]
}

function resolveCliProxyConnection(
  config: WhycodeConfig | null,
  baseModelId: string,
): ModelConnectionResolution {
  let entry: ModelEntry
  try {
    entry = getModelEntry(baseModelId)
  } catch {
    return unsupportedModel(cliProxyModelId(baseModelId))
  }
  if (!getCliProxyModelCompatibility(baseModelId)) {
    return { ok: false, error: `CLIProxyAPI 尚未适配 ${entry.displayName}` }
  }
  const connection = config?.cliProxyApi
  if (!connection) {
    return { ok: false, error: `CLIProxyAPI 尚未启用 ${entry.displayName}` }
  }
  if (!connection.apiKey) {
    return { ok: false, error: 'CLIProxyAPI 尚未配置 API key' }
  }
  const routeModelId = configuredCliProxyRoute(config, baseModelId)
  if (!routeModelId) {
    return {
      ok: false,
      error: `当前 CLIProxyAPI 实例没有公布 ${entry.displayName} 的等价路由，请切换到当前可用模型，或检查 CLIProxyAPI 的账号与服务目录`,
    }
  }
  if (!connection.modelIds.includes(baseModelId)) {
    return { ok: false, error: `CLIProxyAPI 尚未启用 ${entry.displayName}` }
  }
  return {
    ok: true,
    value: {
      entry: cliProxyEntry(entry, routeModelId),
      providerConfig: { apiKey: connection.apiKey, baseURL: connection.baseURL },
    },
  }
}

function configuredCliProxyRoute(
  config: WhycodeConfig | null,
  profileId: string,
): string | null {
  const route = config?.cliProxyApi?.modelRoutes[profileId]
  return route && isCliProxyRoute(profileId, route) ? route : null
}

function listItem(
  entry: ModelEntry,
  resolution: ModelConnectionResolution,
  hasKey: boolean,
): ModelConnectionListItem {
  return {
    id: entry.id,
    displayName: entry.displayName,
    hasKey,
    available: resolution.ok,
    ...(!resolution.ok ? { unavailableReason: resolution.error } : {}),
    supportsImageInput: entry.capabilities.supportsImageInput,
    ...(entry.capabilities.reasoningEffort
      ? { reasoningEffort: entry.capabilities.reasoningEffort }
      : {}),
    retired: false,
  }
}

function retiredListItem(
  id: string,
  displayName: string,
  unavailableReason: string,
): ModelConnectionListItem {
  return {
    id,
    displayName,
    hasKey: false,
    available: false,
    unavailableReason,
    supportsImageInput: false,
    retired: true,
  }
}

function cliProxyEntry(entry: ModelEntry, routeModelId: string): ModelEntry {
  const capabilities = getCliProxyEffectiveCapabilities(entry.id, routeModelId)
  if (!capabilities) {
    throw new Error(`CLIProxyAPI 路由未通过审核：${routeModelId}`)
  }
  return {
    ...entry,
    id: cliProxyModelId(entry.id),
    displayName: `${entry.displayName}（CLIProxyAPI）`,
    capabilities,
    create: (config) => entry.create(config, routeModelId),
  }
}

function unsupportedModel(modelId: string): ModelConnectionResolution {
  return {
    ok: false,
    error: `WhyCode 已不再支持模型 ${modelId}；历史对话仍会保留，请先切换到当前可用模型再发送。`,
  }
}
