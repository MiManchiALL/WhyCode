import type {
  BuiltInProviderId,
  CapabilityProbeState,
  CustomApiProtocol,
  ModelCapabilities,
} from '@whycode/core'

export interface ModelListItem {
  id: string
  displayName: string
  hasKey: boolean
  available: boolean
  unavailableReason?: string
  supportsImageInput: boolean
  custom: boolean
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

export interface CustomConnectionSettingsItem {
  id: string
  name: string
  protocol: CustomApiProtocol
  baseURL: string
  modelId: string
  hasKey: boolean
  matchedProfile?: {
    id: string
    displayName: string
    reasoningExposure: ModelCapabilities['reasoningExposure']
  }
  probe: Record<'text' | 'tools' | 'image', CapabilityProbeState>
  probeDetails?: Partial<Record<'text' | 'tools' | 'image', string>>
  checkedAt: string
}

export interface ModelSettingsSnapshot {
  providers: ProviderSettingsItem[]
  customConnections: CustomConnectionSettingsItem[]
  protocols: Array<{ id: CustomApiProtocol; label: string; hint: string }>
}

export interface SaveProviderSettingsRequest {
  providerId: BuiltInProviderId
  apiKey?: string
  clearApiKey?: boolean
  /** 空字符串恢复内置默认端点。 */
  baseURL?: string
}

export interface SaveCustomConnectionRequest {
  id?: string
  name: string
  protocol: CustomApiProtocol
  baseURL: string
  apiKey?: string
  modelId: string
}

export interface SettingsMutationResult {
  ok: boolean
  error?: string
  snapshot?: ModelSettingsSnapshot
}
