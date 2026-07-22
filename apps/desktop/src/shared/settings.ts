import type {
  BuiltInProviderId,
  ModelCapabilities,
  ReasoningEffortCapability,
} from '@whycode/core'

export interface ModelListItem {
  id: string
  displayName: string
  hasKey: boolean
  available: boolean
  unavailableReason?: string
  supportsImageInput: boolean
  reasoningEffort?: ReasoningEffortCapability
  retired: boolean
}

export interface ProviderSettingsItem {
  id: BuiltInProviderId
  displayName: string
  protocolLabel: string
  defaultBaseURL: string
  baseURL?: string
  hasKey: boolean
  models: Array<{
    id: string
    displayName: string
    capabilities: ModelCapabilities
  }>
}

export interface CliProxyApiSettingsItem {
  displayName: 'CLIProxyAPI'
  baseURL?: string
  hasKey: boolean
  models: Array<{
    id: string
    displayName: string
    available: boolean
    unavailableReason?: string
    enabled: boolean
    reasoningEffort?: ReasoningEffortCapability
  }>
}

export interface ModelSettingsSnapshot {
  providers: ProviderSettingsItem[]
  cliProxyApi: CliProxyApiSettingsItem
  webSearch: WebSearchSettingsItem
}

export interface WebSearchSettingsItem {
  provider: 'perplexity'
  displayName: string
  hasKey: boolean
}

export interface SaveProviderSettingsRequest {
  providerId: BuiltInProviderId
  apiKey?: string
  clearApiKey?: boolean
  /** 空字符串恢复内置默认端点。 */
  baseURL?: string
}

export interface SaveCliProxyApiSettingsRequest {
  baseURL: string
  apiKey?: string
  clearApiKey?: boolean
  modelIds: string[]
}

export interface SaveWebSearchSettingsRequest {
  provider: 'perplexity'
  apiKey?: string
  clearApiKey?: boolean
}

export interface SettingsMutationResult {
  ok: boolean
  error?: string
  snapshot?: ModelSettingsSnapshot
}
