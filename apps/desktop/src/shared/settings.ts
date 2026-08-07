import type {
  BuiltInProviderId,
  McpConfigScope,
  ModelCapabilities,
  ReasoningEffortCapability,
} from '@whycode/core'
import type { McpServerStatus } from '@whycode/core'

export interface ModelListItem {
  id: string
  displayName: string
  hasKey: boolean
  available: boolean
  unavailableReason?: string
  supportsImageInput: boolean
  /** native=主模型直接看图；auxiliary=通过已配置辅助模型；none=当前不可发送图片。 */
  imageInputMode: ImageInputMode
  reasoningEffort?: ReasoningEffortCapability
  retired: boolean
}

export type ImageInputMode = 'native' | 'auxiliary' | 'none'

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
    enabled: boolean
    capabilities: ModelCapabilities
  }>
}

export interface ConnectionSettingsSnapshot {
  providers: ProviderSettingsItem[]
  cliProxyApi: CliProxyApiSettingsItem
  auxiliaryModels: AuxiliaryModelsSettingsItem
  consensusModels: ConsensusModelsSettingsItem
  webSearch: WebSearchSettingsItem
  mcp: McpSettingsItem
}

export interface AuxiliaryModelsSettingsItem {
  visionModelId: string | null
  visionModels: Array<{
    id: string
    displayName: string
  }>
}

export interface SaveAuxiliaryModelSettingsRequest {
  visionModelId: string | null
}

export interface ConsensusModelsSettingsItem {
  agentBModelId: string | null
  agentCModelId: string | null
  models: Array<{
    id: string
    displayName: string
  }>
}

export interface SaveConsensusModelSettingsRequest {
  agentBModelId: string | null
  agentCModelId: string | null
}

export type WebSearchProviderId = 'perplexity' | 'tavily'
export type TavilySearchDepth = 'basic' | 'advanced'

export interface WebSearchSettingsItem {
  activeProvider: WebSearchProviderId
  providers: Array<{
    id: WebSearchProviderId
    displayName: string
    hasKey: boolean
    searchDepth?: TavilySearchDepth
  }>
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
  provider: WebSearchProviderId
  apiKey?: string
  clearApiKey?: boolean
  setActive?: boolean
  searchDepth?: TavilySearchDepth
}

export interface McpSettingsItem {
  globalConfigPath: string
  projectConfigPath?: string
  currentSessionUsesSnapshot: boolean
  servers: Array<{
    name: string
    scope: McpConfigScope
    transport: 'stdio' | 'http'
    enabled: boolean
    effective: boolean
    builtinId?: 'context7' | 'github'
    secretHeaderNames: string[]
    suggestedSecretHeaderName?: string
    suggestedSecretKind?: 'api-key' | 'github-pat'
    oauth?: {
      status: 'connected' | 'available' | 'client-registration-required' | 'unavailable'
      message?: string
    }
    currentSessionState?: McpServerStatus['state']
    currentSessionToolCount?: number
    currentSessionError?: string
    currentSessionDiagnostics: string[]
  }>
  diagnostics: Array<{
    scope: McpConfigScope
    server?: string
    message: string
  }>
}

export interface SetMcpServerEnabledRequest {
  scope: McpConfigScope
  name: string
  enabled: boolean
}

export type AddMcpServerRequest = {
  scope: McpConfigScope
  name: string
  server: {
    transport: 'http'
    url: string
  } | {
    transport: 'stdio'
    command: string
    args: string[]
    cwd?: string
  }
}

export interface SaveMcpSecretHeaderRequest {
  scope: McpConfigScope
  serverName: string
  headerName: string
  secret?: string
  clearSecret?: boolean
}

export interface McpOAuthRequest {
  scope: McpConfigScope
  serverName: string
}

export interface OpenMcpConfigRequest {
  scope: McpConfigScope
}

export interface SettingsMutationResult {
  ok: boolean
  error?: string
  snapshot?: ConnectionSettingsSnapshot
}
