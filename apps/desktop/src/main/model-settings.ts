import { randomUUID } from 'node:crypto'
import {
  BUILTIN_PROVIDERS,
  compactProbeReport,
  createCustomModelEntry,
  CUSTOM_API_PROTOCOLS,
  matchModelProfile,
  MODEL_CATALOG,
  probeCustomConnection,
  type BuiltInProviderId,
  type CustomApiProtocol,
  type CustomConnectionProbeReport,
} from '@whycode/core'
import type {
  CustomConnectionSettingsItem,
  ModelSettingsSnapshot,
  SaveCustomConnectionRequest,
  SaveProviderSettingsRequest,
} from '../shared/settings.ts'
import {
  customModelId,
  type CustomConnectionConfig,
  type WhycodeConfig,
} from './config.ts'

const MAX_PROBE_DETAIL_CHARS = 1_000
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u

export interface CustomConnectionUpdateResult {
  config?: WhycodeConfig
  report?: CustomConnectionProbeReport
  error?: string
}

export function createModelSettingsSnapshot(
  config: WhycodeConfig | null,
): ModelSettingsSnapshot {
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
    customConnections: (config?.customConnections ?? []).map(customSettingsItem),
    protocols: CUSTOM_API_PROTOCOLS.map((protocol) => ({ ...protocol })),
  }
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

export async function testAndUpdateCustomConnection(
  config: WhycodeConfig | null,
  request: SaveCustomConnectionRequest,
  abortSignal: AbortSignal,
): Promise<CustomConnectionUpdateResult> {
  let draft: ValidatedCustomDraft
  try {
    draft = validateCustomDraft(config, request)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const probeEntry = createCustomModelEntry({
    id: customModelId(draft.id),
    connectionName: draft.name,
    protocol: draft.protocol,
    modelId: draft.modelId,
    probe: { text: 'unknown', tools: 'unknown', image: 'unknown' },
  })
  let report: CustomConnectionProbeReport
  try {
    report = await probeCustomConnection(
      probeEntry.create({ apiKey: draft.apiKey, baseURL: draft.baseURL }),
      { abortSignal, providerOptions: probeEntry.providerOptions },
    )
  } catch (error) {
    return { error: safeError(error, draft.apiKey) }
  }
  report = redactReport(report, draft.apiKey)
  if (report.text.state !== 'supported') {
    return { report, error: `文本连接检测未通过：${report.text.detail}` }
  }

  const connection: CustomConnectionConfig = {
    ...draft,
    probe: compactProbeReport(report),
    probeDetails: {
      text: report.text.detail,
      tools: report.tools.detail,
      image: report.image.detail,
    },
    checkedAt: new Date().toISOString(),
  }
  const next = cloneConfig(config)
  next.customConnections = [
    ...(next.customConnections ?? []).filter((item) => item.id !== connection.id),
    connection,
  ]
  return { config: next, report }
}

export function deleteCustomConnection(
  config: WhycodeConfig | null,
  connectionId: string,
): WhycodeConfig {
  const next = cloneConfig(config)
  if (!next.customConnections?.some((item) => item.id === connectionId)) {
    throw new Error('自定义连接不存在')
  }
  next.customConnections = next.customConnections.filter((item) => item.id !== connectionId)
  if (next.defaultModel === customModelId(connectionId)) delete next.defaultModel
  return next
}

function customSettingsItem(connection: CustomConnectionConfig): CustomConnectionSettingsItem {
  const match = matchModelProfile(connection.modelId)
  return {
    id: connection.id,
    name: connection.name,
    protocol: connection.protocol,
    baseURL: connection.baseURL,
    modelId: connection.modelId,
    hasKey: Boolean(connection.apiKey),
    ...(match.status === 'matched' ? {
      matchedProfile: { id: match.profile.id, displayName: match.profile.displayName },
    } : {}),
    probe: connection.probe,
    ...(connection.probeDetails ? { probeDetails: connection.probeDetails } : {}),
    checkedAt: connection.checkedAt,
  }
}

interface ValidatedCustomDraft {
  id: string
  name: string
  protocol: CustomApiProtocol
  baseURL: string
  apiKey: string
  modelId: string
}

function validateCustomDraft(
  config: WhycodeConfig | null,
  request: SaveCustomConnectionRequest,
): ValidatedCustomDraft {
  const existing = request.id
    ? config?.customConnections?.find((item) => item.id === request.id)
    : undefined
  if (request.id && !existing) throw new Error('要编辑的自定义连接不存在')
  const name = request.name.trim()
  const modelId = request.modelId.trim()
  const apiKey = request.apiKey?.trim() || existing?.apiKey || ''
  if (!name || name.length > 80) throw new Error('连接名称必须为 1–80 个字符')
  if (!modelId || modelId.length > 200) throw new Error('模型 ID 必须为 1–200 个字符')
  if (CONTROL_CHARACTER.test(name)) throw new Error('连接名称不能包含控制字符')
  if (CONTROL_CHARACTER.test(modelId)) throw new Error('模型 ID 不能包含控制字符')
  if (!apiKey) throw new Error('请填写 API key')
  if (!CUSTOM_API_PROTOCOLS.some((item) => item.id === request.protocol)) {
    throw new Error('API 协议不受支持')
  }
  return {
    id: request.id ?? randomUUID(),
    name,
    protocol: request.protocol,
    baseURL: normalizeRequiredBaseURL(request.baseURL),
    apiKey,
    modelId,
  }
}

function cloneConfig(config: WhycodeConfig | null): WhycodeConfig {
  return config ? structuredClone(config) : { providers: {} }
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

function protocolLabel(protocol: CustomApiProtocol): string {
  return CUSTOM_API_PROTOCOLS.find((item) => item.id === protocol)?.label ?? protocol
}

function redactReport(
  report: CustomConnectionProbeReport,
  apiKey: string,
): CustomConnectionProbeReport {
  return {
    text: { ...report.text, detail: redact(report.text.detail, apiKey) },
    tools: { ...report.tools, detail: redact(report.tools.detail, apiKey) },
    image: { ...report.image, detail: redact(report.image.detail, apiKey) },
  }
}

function safeError(error: unknown, apiKey: string): string {
  return redact(error instanceof Error ? error.message : String(error), apiKey)
}

function redact(value: string, apiKey: string): string {
  const redacted = apiKey ? value.replaceAll(apiKey, '[已隐藏 API key]') : value
  return redacted.length > MAX_PROBE_DETAIL_CHARS
    ? `${redacted.slice(0, MAX_PROBE_DETAIL_CHARS)}…`
    : redacted
}
