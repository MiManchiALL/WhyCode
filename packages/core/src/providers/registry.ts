import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel, ProviderMetadata } from 'ai'
import {
  getBuiltInProvider,
  getModelProfile,
  type ModelCapabilities,
  type ModelProviderId,
  type ProviderProtocol,
} from './catalog.ts'

export type { ModelCapabilities } from './catalog.ts'

export interface ModelEntry {
  /** WhyCode 内部模型 ID，格式 provider:model */
  id: string
  displayName: string
  provider: ModelProviderId
  /** 决定工具图片在 provider 请求边界使用原生结果还是 Chat 兼容投影。 */
  protocol: ProviderProtocol
  capabilities: ModelCapabilities
  /** 创建 AI SDK LanguageModel 实例 */
  create: (config: ProviderConfig) => LanguageModel
  /** 随每次请求透传给 AI SDK 的 providerOptions（厂商特殊参数逃生舱） */
  providerOptions?: ProviderMetadata
}

export interface ProviderConfig {
  apiKey: string
  /** 自定义端点（自建网关/代理场景） */
  baseURL?: string
}

function registryEntry(
  profileId: string,
  create: ModelEntry['create'],
): ModelEntry {
  const profile = getModelProfile(profileId)
  return {
    id: profile.id,
    displayName: profile.displayName,
    provider: profile.provider,
    protocol: getBuiltInProvider(profile.provider).protocol,
    capabilities: profile.capabilities,
    providerOptions: profile.providerOptions,
    create,
  }
}

function googleChat(modelId: string): ModelEntry['create'] {
  return (config) => createOpenAICompatible({
    name: 'google',
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('google').defaultBaseURL,
    supportsStructuredOutputs: true,
  })(modelId)
}

function openAIResponses(modelId: string): ModelEntry['create'] {
  return (config) => createOpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL ?? getBuiltInProvider('openai').defaultBaseURL,
  }).responses(modelId)
}

/** 内置模型的官方连接适配器；模型固有信息只维护在 catalog.ts。 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  registryEntry(
    'anthropic:claude-sonnet-4-6',
    (config) =>
      createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? getBuiltInProvider('anthropic').defaultBaseURL,
      })(
        'claude-sonnet-4-6',
      ),
  ),
  registryEntry(
    'deepseek:deepseek-v4-flash',
    (config) =>
      createDeepSeek({
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? getBuiltInProvider('deepseek').defaultBaseURL,
      })(
        'deepseek-v4-flash',
      ),
  ),
  registryEntry(
    'google:gemini-3.1-pro-preview',
    googleChat('gemini-3.1-pro-preview'),
  ),
  registryEntry(
    'google:gemini-3.5-flash',
    googleChat('gemini-3.5-flash'),
  ),
  registryEntry(
    'mimo:mimo-v2.5',
    (config) =>
      createOpenAICompatible({
        name: 'mimo',
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? getBuiltInProvider('mimo').defaultBaseURL,
      })('mimo-v2.5'),
  ),
  registryEntry(
    'zhipu:glm-5v-turbo',
    (config) =>
      createOpenAICompatible({
        name: 'zhipu',
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? getBuiltInProvider('zhipu').defaultBaseURL,
      })('glm-5v-turbo'),
  ),
  registryEntry(
    'zhipu:glm-4.7',
    (config) =>
      createOpenAICompatible({
        name: 'zhipu',
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? getBuiltInProvider('zhipu').defaultBaseURL,
      })('glm-4.7'),
  ),
  registryEntry(
    'openai:gpt-5.6-sol',
    openAIResponses('gpt-5.6-sol'),
  ),
  registryEntry(
    'openai:gpt-5.6-terra',
    openAIResponses('gpt-5.6-terra'),
  ),
  registryEntry(
    'openai:gpt-5.6-luna',
    openAIResponses('gpt-5.6-luna'),
  ),
  registryEntry(
    'openai:gpt-5.5',
    openAIResponses('gpt-5.5'),
  ),
  registryEntry(
    'openai:gpt-5.2',
    openAIResponses('gpt-5.2'),
  ),
] as const

export function getModelEntry(modelId: string): ModelEntry {
  const entry = MODEL_REGISTRY.find((m) => m.id === modelId)
  if (!entry) {
    throw new Error(`未注册的模型 ID: ${modelId}`)
  }
  return entry
}
