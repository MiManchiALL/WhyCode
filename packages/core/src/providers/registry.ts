import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel, ProviderMetadata } from 'ai'
import {
  getBuiltInProvider,
  getModelProfile,
  type BuiltInProviderId,
  type ModelCapabilities,
  type ProviderProtocol,
} from './catalog.ts'

export type {
  ModelCapabilities,
  ReasoningEffortCapability,
  ReasoningEffortSelection,
} from './catalog.ts'

export interface ModelEntry {
  /** WhyCode 内部模型 ID，格式 provider:model */
  id: string
  displayName: string
  provider: BuiltInProviderId
  /** 决定工具图片在 provider 请求边界使用原生结果还是 Chat 兼容投影。 */
  protocol: ProviderProtocol
  capabilities: ModelCapabilities
  /** 创建 AI SDK LanguageModel；连接适配器负责把传输身份映射到具体协议。 */
  create: (config: ProviderConfig, options?: ModelCreateOptions) => LanguageModel
  /** 随每次请求透传给 AI SDK 的 providerOptions（厂商特殊参数逃生舱） */
  providerOptions?: ProviderMetadata
}

export interface ProviderConfig {
  apiKey: string
  /** 同协议端点（透明中转/代理场景） */
  baseURL?: string
  /** 只由连接适配器生成，不来自用户配置。 */
  requestHeaders?: Readonly<Record<string, string>>
}

export interface ModelCreateOptions {
  /** 只供已审核的连接映射覆盖；省略时使用目录中的官方 API ID。 */
  wireModelId?: string
  /** 独立模型会话的稳定身份；是否透传及如何编码由连接适配器决定。 */
  transportSessionId?: string
}

type ModelFactory = (config: ProviderConfig, wireModelId: string) => LanguageModel

function registryEntry(profileId: string, factory: ModelFactory): ModelEntry {
  const profile = getModelProfile(profileId)
  return {
    id: profile.id,
    displayName: profile.displayName,
    provider: profile.provider,
    protocol: getBuiltInProvider(profile.provider).protocol,
    capabilities: profile.capabilities,
    providerOptions: profile.providerOptions,
    create: (config, options) => factory(config, options?.wireModelId ?? profile.modelId),
  }
}

const anthropicMessages: ModelFactory = (config, wireModelId) =>
  createAnthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('anthropic').defaultBaseURL,
    headers: copyRequestHeaders(config),
  })(wireModelId)

const deepSeekChat: ModelFactory = (config, wireModelId) =>
  createDeepSeek({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('deepseek').defaultBaseURL,
    headers: copyRequestHeaders(config),
  })(wireModelId)

const googleChat: ModelFactory = (config, wireModelId) =>
  createOpenAICompatible({
    name: 'google',
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('google').defaultBaseURL,
    headers: copyRequestHeaders(config),
    supportsStructuredOutputs: true,
  })(wireModelId)

const mimoChat: ModelFactory = (config, wireModelId) =>
  createOpenAICompatible({
    name: 'mimo',
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('mimo').defaultBaseURL,
    headers: copyRequestHeaders(config),
  })(wireModelId)

const zhipuChat: ModelFactory = (config, wireModelId) =>
  createOpenAICompatible({
    name: 'zhipu',
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('zhipu').defaultBaseURL,
    headers: copyRequestHeaders(config),
  })(wireModelId)

const openAIResponses: ModelFactory = (config, wireModelId) =>
  createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('openai').defaultBaseURL,
    headers: copyRequestHeaders(config),
  }).responses(wireModelId)

function copyRequestHeaders(config: ProviderConfig): Record<string, string> | undefined {
  return config.requestHeaders ? { ...config.requestHeaders } : undefined
}

/** 内置模型的官方连接适配器；模型固有信息只维护在 catalog.ts。 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  registryEntry(
    'anthropic:claude-sonnet-4-6',
    anthropicMessages,
  ),
  registryEntry(
    'deepseek:deepseek-v4-flash',
    deepSeekChat,
  ),
  registryEntry(
    'deepseek:deepseek-v4-pro',
    deepSeekChat,
  ),
  registryEntry(
    'google:gemini-3.1-pro-preview',
    googleChat,
  ),
  registryEntry(
    'google:gemini-3.7-flash',
    googleChat,
  ),
  registryEntry(
    'mimo:mimo-v2.5',
    mimoChat,
  ),
  registryEntry(
    'zhipu:glm-5v-turbo',
    zhipuChat,
  ),
  registryEntry(
    'zhipu:glm-4.7',
    zhipuChat,
  ),
  registryEntry(
    'openai:gpt-5.6-sol',
    openAIResponses,
  ),
  registryEntry(
    'openai:gpt-5.6-terra',
    openAIResponses,
  ),
  registryEntry(
    'openai:gpt-5.6-luna',
    openAIResponses,
  ),
  registryEntry(
    'openai:gpt-5.5',
    openAIResponses,
  ),
] as const

export function getModelEntry(modelId: string): ModelEntry {
  const entry = MODEL_REGISTRY.find((m) => m.id === modelId)
  if (!entry) {
    throw new Error(`未注册的模型 ID: ${modelId}`)
  }
  return entry
}
