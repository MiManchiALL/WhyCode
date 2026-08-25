import {
  getModelEntry,
  MODEL_REGISTRY,
  normalizeReasoningEffortSelection,
  type ModelEntry,
  type ProviderConfig,
  type SubagentModelSnapshot,
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
import type { ImageInputMode, ModelListItem } from '../shared/settings.ts'

export interface ResolvedModelConnection {
  entry: ModelEntry
  providerConfig: ProviderConfig
}

export type ModelConnectionResolution =
  | { ok: true; value: ResolvedModelConnection }
  | { ok: false; error: string }

export type ModelConnectionListItem = ModelListItem

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
  const auxiliaryVisionAvailable = resolveAuxiliaryVisionModel(config) !== null
  const builtIn = MODEL_REGISTRY.flatMap((entry) => {
    if (!config?.providers[entry.provider]?.apiKey) return []
    return [listItem(
      entry,
      resolveModelConnection(config, entry.id),
      true,
      auxiliaryVisionAvailable,
    )]
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
        auxiliaryVisionAvailable,
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
            auxiliaryVisionAvailable,
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
        listItem(
          entry,
          resolveModelConnection(config, selectedModelId),
          false,
          auxiliaryVisionAvailable,
        ),
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

export function imageInputModeForModel(
  config: WhycodeConfig | null,
  model: ModelEntry,
): ImageInputMode {
  if (model.capabilities.supportsImageInput) return 'native'
  return resolveAuxiliaryVisionModel(config) ? 'auxiliary' : 'none'
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
  auxiliaryVisionAvailable: boolean,
): ModelConnectionListItem {
  return {
    id: entry.id,
    displayName: entry.displayName,
    hasKey,
    available: resolution.ok,
    ...(!resolution.ok ? { unavailableReason: resolution.error } : {}),
    supportsImageInput: entry.capabilities.supportsImageInput,
    imageInputMode: resolution.ok
      ? entry.capabilities.supportsImageInput
        ? 'native'
        : auxiliaryVisionAvailable ? 'auxiliary' : 'none'
      : 'none',
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
    imageInputMode: 'none',
    retired: true,
  }
}

export interface AuxiliaryVisionModelCandidate {
  id: string
  displayName: string
}

export type ConfiguredModelCandidate = AuxiliaryVisionModelCandidate

/** 只返回当前确实可解析的统一模型连接；设置页和运行时共用同一组精确 ID。 */
export function listConfiguredModelCandidates(
  config: WhycodeConfig | null,
): ConfiguredModelCandidate[] {
  return listModelConnections(config).flatMap((model) =>
    model.available && !model.retired
      ? [{ id: model.id, displayName: model.displayName }]
      : [])
}

/** 只列出当前确实可解析、且声明原生图片输入能力的已配置模型。 */
export function listAuxiliaryVisionModelCandidates(
  config: WhycodeConfig | null,
): AuxiliaryVisionModelCandidate[] {
  return listConfiguredModelCandidates(config).flatMap((candidate) => {
    const resolution = resolveModelConnection(config, candidate.id)
    if (!resolution.ok || !resolution.value.entry.capabilities.supportsImageInput) return []
    return [candidate]
  })
}

export function resolveAuxiliaryVisionModel(
  config: WhycodeConfig | null,
): ResolvedModelConnection | null {
  const modelId = config?.auxiliaryModels?.visionModelId
  if (!modelId) return null
  const resolution = resolveModelConnection(config, modelId)
  return resolution.ok && resolution.value.entry.capabilities.supportsImageInput
    ? resolution.value
    : null
}

/** 新建子代理在启动边界冻结一次模型；未固定时继承父会话当前选择。 */
export function resolveSubagentModelSelection(
  config: WhycodeConfig | null,
  parent: SubagentModelSnapshot,
): SubagentModelSnapshot | null {
  const modelId = config?.auxiliaryModels?.subagentModelId ?? parent.modelId
  const resolution = resolveModelConnection(config, modelId)
  if (!resolution.ok) return null
  return {
    modelId,
    reasoningEffort: normalizeReasoningEffortSelection(
      resolution.value.entry.capabilities,
      parent.reasoningEffort,
    ),
  }
}

/** 连接变更后辅助选择必须继续精确可用；逐项清空，绝不猜测替补模型。 */
export function pruneInvalidAuxiliaryModels(config: WhycodeConfig): WhycodeConfig {
  const current = config.auxiliaryModels
  if (!current) return config
  const visionModelId = current.visionModelId && resolveAuxiliaryVisionModel(config)
    ? current.visionModelId
    : undefined
  const subagentModelId = current.subagentModelId
    && resolveModelConnection(config, current.subagentModelId).ok
    ? current.subagentModelId
    : undefined
  if (
    visionModelId === current.visionModelId
    && subagentModelId === current.subagentModelId
  ) return config
  const next = structuredClone(config)
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

/** 模型连接被删除后同步清理 B/C 的失效选择，不保留第二套连接或隐式回退。 */
export function pruneInvalidConsensusAgents(config: WhycodeConfig): WhycodeConfig {
  const current = config.consensusAgents
  if (!current) return config
  const retained: NonNullable<WhycodeConfig['consensusAgents']> = {}
  for (const id of ['B', 'C'] as const) {
    const agent = current[id]
    if (agent && resolveModelConnection(config, agent.modelId).ok) retained[id] = agent
  }
  if (Object.keys(retained).length === Object.keys(current).length) return config
  const next = structuredClone(config)
  if (Object.keys(retained).length > 0) next.consensusAgents = retained
  else delete next.consensusAgents
  return next
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
    create: (config, options) => entry.create({
      ...config,
      requestHeaders: options?.transportSessionId
        ? {
            ...config.requestHeaders,
            'X-Session-ID': options.transportSessionId,
          }
        : config.requestHeaders,
    }, { wireModelId: routeModelId }),
  }
}

function unsupportedModel(modelId: string): ModelConnectionResolution {
  return {
    ok: false,
    error: `WhyCode 已不再支持模型 ${modelId}；历史对话仍会保留，请先切换到当前可用模型再发送。`,
  }
}
