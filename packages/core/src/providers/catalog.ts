import type { ProviderMetadata } from 'ai'

export type BuiltInProviderId = 'anthropic' | 'deepseek' | 'mimo' | 'openai' | 'zhipu'
export type ModelProviderId = BuiltInProviderId | 'custom'

export interface ModelCapabilities {
  /** 原生 function calling 是否可靠可用（false 时不能作为完整 Agent 使用）。 */
  supportsNativeTools: boolean
  /** 是否允许在 user message 中发送图片；未知或未验证的接入一律关闭。 */
  supportsImageInput: boolean
  /** WhyCode 已验证该接入可接收不缩放（仍受 20 MB 安全上限）的图片。 */
  supportsOriginalImageDetail?: boolean
  /** 厂商暴露推理过程的协议形态。 */
  reasoningExposure: 'block' | 'field' | 'summary' | 'none'
  /** 结构化输出最高档位。 */
  structuredOutput: 'json-schema' | 'tool-based' | 'json-object' | 'prompt'
  /** 厂商 prompt cache 行为。 */
  promptCaching: 'explicit' | 'auto' | 'none'
  contextWindow: number
  maxOutput: number
}

export interface BuiltInProviderProfile {
  id: BuiltInProviderId
  displayName: string
  protocol: 'anthropic-messages' | 'openai-chat' | 'openai-responses'
  defaultBaseURL: string
}

export interface ModelProfile {
  /** WhyCode 稳定模型 ID。 */
  id: string
  /** 发给厂商 API 的模型 ID。 */
  modelId: string
  displayName: string
  provider: BuiltInProviderId
  /** 仅列明确等价的名称，不做编辑距离或子串猜测。 */
  aliases: readonly string[]
  capabilities: ModelCapabilities
  providerOptions?: ProviderMetadata
}

export const BUILTIN_PROVIDERS: readonly BuiltInProviderProfile[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    protocol: 'anthropic-messages',
    defaultBaseURL: 'https://api.anthropic.com/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    protocol: 'openai-chat',
    defaultBaseURL: 'https://api.deepseek.com/v1',
  },
  {
    id: 'mimo',
    displayName: '小米 MiMo',
    protocol: 'openai-chat',
    defaultBaseURL: 'https://api.xiaomimimo.com/v1',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    protocol: 'openai-responses',
    defaultBaseURL: 'https://api.openai.com/v1',
  },
  {
    id: 'zhipu',
    displayName: '智谱 GLM',
    protocol: 'openai-chat',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
] as const

/**
 * 模型固有信息目录。自定义网关的文本、工具和图片传输能力以端点实测为准。
 */
export const MODEL_CATALOG: readonly ModelProfile[] = [
  {
    id: 'anthropic:claude-sonnet-4-6',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    aliases: ['Claude-Sonnet-4.6', 'Claude Sonnet 4.6'],
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'block',
      structuredOutput: 'json-schema',
      promptCaching: 'explicit',
      contextWindow: 1_000_000,
      maxOutput: 64_000,
    },
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  },
  {
    id: 'deepseek:deepseek-v4-flash',
    modelId: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    aliases: ['DeepSeek-V4-Flash', 'DeepSeek V4 Flash'],
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'field',
      structuredOutput: 'json-object',
      promptCaching: 'auto',
      contextWindow: 1_000_000,
      maxOutput: 384_000,
    },
  },
  {
    id: 'mimo:mimo-v2.5',
    modelId: 'mimo-v2.5',
    displayName: 'MiMo V2.5',
    provider: 'mimo',
    aliases: ['MiMo V2.5', 'MiMo-V2.5'],
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      supportsOriginalImageDetail: true,
      reasoningExposure: 'field',
      structuredOutput: 'json-object',
      promptCaching: 'auto',
      contextWindow: 1_048_576,
      maxOutput: 131_072,
    },
    providerOptions: { mimo: { thinking: { type: 'enabled' } } },
  },
  {
    id: 'zhipu:glm-5v-turbo',
    modelId: 'glm-5v-turbo',
    displayName: 'GLM-5V-Turbo',
    provider: 'zhipu',
    aliases: ['GLM 5V Turbo', 'GLM-5V Turbo'],
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      // WhyCode 当前关闭其 thinking，以保留已真实验通的工具调用后最终答复。
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'auto',
      contextWindow: 200_000,
      maxOutput: 128_000,
    },
    providerOptions: { zhipu: { thinking: { type: 'disabled' } } },
  },
  {
    id: 'zhipu:glm-4.7',
    modelId: 'glm-4.7',
    displayName: 'GLM-4.7',
    provider: 'zhipu',
    aliases: ['GLM 4.7', 'GLM_4.7'],
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      // thinking + 工具会吞掉最终正文的兼容缺陷仍可复现，见开发便签。
      reasoningExposure: 'none',
      structuredOutput: 'json-schema',
      promptCaching: 'auto',
      contextWindow: 200_000,
      maxOutput: 128_000,
    },
    providerOptions: { zhipu: { thinking: { type: 'disabled' } } },
  },
  {
    id: 'openai:gpt-5.2',
    modelId: 'gpt-5.2',
    displayName: 'GPT-5.2',
    provider: 'openai',
    aliases: ['GPT 5.2', 'GPT-5.2'],
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'summary',
      structuredOutput: 'json-schema',
      promptCaching: 'auto',
      contextWindow: 400_000,
      maxOutput: 128_000,
    },
  },
] as const

export type ModelProfileMatch =
  | { status: 'matched'; profile: ModelProfile }
  | { status: 'ambiguous'; profiles: readonly ModelProfile[] }
  | { status: 'none' }

/**
 * 只消除书写差异：Unicode 宽窄、大小写、空格和标点分隔符。
 * 不做子串、编辑距离或版本近似，因此不会把未知型号误认成相近型号。
 */
export function normalizeModelIdentity(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

export function matchModelProfile(
  value: string,
  profiles: readonly ModelProfile[] = MODEL_CATALOG,
): ModelProfileMatch {
  const identity = normalizeModelIdentity(value)
  if (!identity) return { status: 'none' }
  const matches = profiles.filter((profile) =>
    profileIdentities(profile).some((candidate) => normalizeModelIdentity(candidate) === identity),
  )
  if (matches.length === 1) return { status: 'matched', profile: matches[0]! }
  if (matches.length > 1) return { status: 'ambiguous', profiles: matches }
  return { status: 'none' }
}

export function getModelProfile(profileId: string): ModelProfile {
  const profile = MODEL_CATALOG.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error(`未维护的模型画像：${profileId}`)
  return profile
}

export function getBuiltInProvider(providerId: BuiltInProviderId): BuiltInProviderProfile {
  return BUILTIN_PROVIDERS.find((provider) => provider.id === providerId)!
}

function profileIdentities(profile: ModelProfile): readonly string[] {
  return [profile.id, profile.modelId, profile.displayName, ...profile.aliases]
}
