import type { ProviderMetadata } from 'ai'

export type BuiltInProviderId =
  | 'anthropic'
  | 'deepseek'
  | 'google'
  | 'mimo'
  | 'openai'
  | 'zhipu'
export type ProviderProtocol = 'anthropic-messages' | 'openai-chat' | 'openai-responses'

export const REASONING_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export type ReasoningEffort = (typeof REASONING_EFFORT_LEVELS)[number]
export type ReasoningEffortSelection = 'default' | ReasoningEffort

export interface ReasoningEffortCapability {
  /** 端点接受的显式档位；顺序同时是 UI 展示顺序。 */
  supported: readonly ReasoningEffort[]
  /** 厂商文档明确给出的默认档位。 */
  default: ReasoningEffort
}

export interface ModelCapabilities {
  /** 原生 function calling 是否可靠可用（false 时不能作为完整 Agent 使用）。 */
  supportsNativeTools: boolean
  /** 是否允许在 user message 中发送图片；未知或未验证的接入一律关闭。 */
  supportsImageInput: boolean
  /** WhyCode 已验证该接入可接收不缩放（仍受 20 MB 安全上限）的图片。 */
  supportsOriginalImageDetail?: boolean
  /** 厂商暴露推理过程的协议形态。 */
  reasoningExposure: 'block' | 'field' | 'summary' | 'none'
  /** 可由 WhyCode 显式控制的推理强度；未声明时 UI 不猜测。 */
  reasoningEffort?: ReasoningEffortCapability
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
  protocol: ProviderProtocol
  defaultBaseURL: string
}

export interface ModelProfile {
  /** WhyCode 稳定模型 ID。 */
  id: string
  /** 发给厂商 API 的模型 ID。 */
  modelId: string
  displayName: string
  provider: BuiltInProviderId
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
    id: 'google',
    displayName: 'Google Gemini',
    protocol: 'openai-chat',
    defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
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

const GOOGLE_THINKING_SUMMARY_OPTIONS = {
  google: {
    extra_body: {
      google: {
        thinking_config: { include_thoughts: true },
      },
    },
  },
} satisfies ProviderMetadata

const DEEPSEEK_V4_CAPABILITIES = {
  supportsNativeTools: true,
  supportsImageInput: false,
  reasoningExposure: 'field',
  reasoningEffort: {
    supported: ['high', 'max'],
    default: 'high',
  },
  structuredOutput: 'json-object',
  promptCaching: 'auto',
  contextWindow: 1_000_000,
  maxOutput: 384_000,
} satisfies ModelCapabilities

const DEEPSEEK_THINKING_OPTIONS = {
  deepseek: { thinking: { type: 'enabled' } },
} satisfies ProviderMetadata

const OPENAI_REASONING_SUMMARY_OPTIONS = {
  openai: {
    // 路由别名不一定以 gpt-5 开头；画像已经确认其为推理模型，不能让 SDK 再按名字猜。
    forceReasoning: true,
    reasoningSummary: 'auto',
    // WhyCode owns durable history. Keep Responses stateless and replay encrypted
    // reasoning locally instead of depending on provider-side item persistence.
    store: false,
  },
} satisfies ProviderMetadata

const GPT_5_6_CAPABILITIES = {
  supportsNativeTools: true,
  supportsImageInput: true,
  reasoningExposure: 'summary',
  reasoningEffort: {
    supported: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    default: 'medium',
  },
  structuredOutput: 'json-schema',
  promptCaching: 'auto',
  contextWindow: 1_050_000,
  maxOutput: 128_000,
} satisfies ModelCapabilities

/**
 * 模型固有信息目录。官方端点与中转 BaseURL 共用同一注册型号和能力契约。
 */
export const MODEL_CATALOG: readonly ModelProfile[] = [
  {
    id: 'anthropic:claude-sonnet-4-6',
    modelId: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'block',
      reasoningEffort: {
        supported: ['low', 'medium', 'high', 'max'],
        default: 'high',
      },
      structuredOutput: 'json-schema',
      promptCaching: 'explicit',
      contextWindow: 1_000_000,
      maxOutput: 64_000,
    },
    providerOptions: {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
        thinking: { type: 'adaptive' },
      },
    },
  },
  {
    id: 'deepseek:deepseek-v4-flash',
    modelId: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    capabilities: DEEPSEEK_V4_CAPABILITIES,
    providerOptions: DEEPSEEK_THINKING_OPTIONS,
  },
  {
    id: 'deepseek:deepseek-v4-pro',
    modelId: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    provider: 'deepseek',
    capabilities: DEEPSEEK_V4_CAPABILITIES,
    providerOptions: DEEPSEEK_THINKING_OPTIONS,
  },
  {
    id: 'google:gemini-3.1-pro-preview',
    modelId: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro Preview',
    provider: 'google',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'summary',
      reasoningEffort: {
        supported: ['low', 'medium', 'high'],
        default: 'high',
      },
      structuredOutput: 'json-schema',
      promptCaching: 'auto',
      contextWindow: 1_048_576,
      maxOutput: 65_536,
    },
    providerOptions: GOOGLE_THINKING_SUMMARY_OPTIONS,
  },
  {
    id: 'google:gemini-3.7-flash',
    modelId: 'gemini-3.7-flash',
    displayName: 'Gemini 3.7 Flash',
    provider: 'google',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'summary',
      reasoningEffort: {
        supported: ['low', 'medium', 'high'],
        default: 'medium',
      },
      structuredOutput: 'json-schema',
      promptCaching: 'auto',
      contextWindow: 1_048_576,
      maxOutput: 65_536,
    },
    providerOptions: GOOGLE_THINKING_SUMMARY_OPTIONS,
  },
  {
    id: 'mimo:mimo-v2.5',
    modelId: 'mimo-v2.5',
    displayName: 'MiMo V2.5',
    provider: 'mimo',
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
    id: 'openai:gpt-5.6-sol',
    modelId: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    provider: 'openai',
    capabilities: GPT_5_6_CAPABILITIES,
    providerOptions: OPENAI_REASONING_SUMMARY_OPTIONS,
  },
  {
    id: 'openai:gpt-5.6-terra',
    modelId: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    provider: 'openai',
    capabilities: GPT_5_6_CAPABILITIES,
    providerOptions: OPENAI_REASONING_SUMMARY_OPTIONS,
  },
  {
    id: 'openai:gpt-5.6-luna',
    modelId: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    provider: 'openai',
    capabilities: GPT_5_6_CAPABILITIES,
    providerOptions: OPENAI_REASONING_SUMMARY_OPTIONS,
  },
  {
    id: 'openai:gpt-5.5',
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    provider: 'openai',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'summary',
      reasoningEffort: {
        supported: ['none', 'low', 'medium', 'high', 'xhigh'],
        default: 'medium',
      },
      structuredOutput: 'json-schema',
      promptCaching: 'auto',
      contextWindow: 1_050_000,
      maxOutput: 128_000,
    },
    providerOptions: OPENAI_REASONING_SUMMARY_OPTIONS,
  },
] as const

export function getModelProfile(profileId: string): ModelProfile {
  const profile = MODEL_CATALOG.find((candidate) => candidate.id === profileId)
  if (!profile) throw new Error(`未维护的模型画像：${profileId}`)
  return profile
}

export function getBuiltInProvider(providerId: BuiltInProviderId): BuiltInProviderProfile {
  return BUILTIN_PROVIDERS.find((provider) => provider.id === providerId)!
}
