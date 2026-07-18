import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelCapabilities, ProviderProtocol } from './catalog.ts'
import {
  getBuiltInProvider,
  matchCustomModelProfile,
  parseCustomModelThinkingSuffix,
} from './catalog.ts'
import type { ModelEntry } from './registry.ts'

export type CustomApiProtocol = ProviderProtocol

export interface CustomApiProtocolDescriptor {
  id: CustomApiProtocol
  label: string
  hint: string
}

export const CUSTOM_API_PROTOCOLS: readonly CustomApiProtocolDescriptor[] = [
  {
    id: 'openai-chat',
    label: 'OpenAI Chat Completions 兼容',
    hint: '常见于 DeepSeek、MiMo、GLM、OneAPI、LiteLLM。Base URL 填到版本根路径（如 https://host/v1），WhyCode 会调用其 /chat/completions。',
  },
  {
    id: 'openai-responses',
    label: 'OpenAI Responses 兼容',
    hint: '用于 OpenAI 或实现 Responses 的兼容网关。Base URL 填到版本根路径（如 https://host/v1），WhyCode 会调用其 /responses。',
  },
  {
    id: 'anthropic-messages',
    label: 'Anthropic Messages 兼容',
    hint: '用于 Claude 或兼容网关。Base URL 填到版本根路径（如 https://host/v1），WhyCode 会调用其 /messages。',
  },
] as const

export type CapabilityProbeState = 'supported' | 'unsupported' | 'unknown'

export interface CustomConnectionProbe {
  text: CapabilityProbeState
  tools: CapabilityProbeState
  image: CapabilityProbeState
}

export interface CustomModelEntryOptions {
  id: string
  connectionName: string
  protocol: CustomApiProtocol
  modelId: string
  probe: CustomConnectionProbe
}

const UNKNOWN_MODEL_CAPABILITIES: ModelCapabilities = {
  supportsNativeTools: false,
  supportsImageInput: false,
  reasoningExposure: 'none',
  structuredOutput: 'prompt',
  promptCaching: 'none',
  contextWindow: 32_000,
  maxOutput: 8_000,
}

/**
 * 自定义连接先继承严格匹配到的固有画像；文本、工具和图片传输能力以该端点
 * 的可验证探测结果为准。未匹配型号不猜测上下文、thinking 或缓存能力。
 */
export function createCustomModelEntry(options: CustomModelEntryOptions): ModelEntry {
  const matched = matchCustomModelProfile(options.modelId)
  const profile = matched.status === 'matched' ? matched.profile : null
  const base = profile?.capabilities ?? UNKNOWN_MODEL_CAPABILITIES
  const supportsNativeTools = options.probe.tools === 'supported'
  const supportsImageInput = options.probe.image === 'supported'
  const adapterName = profile?.provider ?? 'custom'
  const inheritedProviderOptions = profile
    && getBuiltInProvider(profile.provider).protocol === options.protocol
    ? profile.providerOptions
    : undefined
  const providerOptions = resolveCustomProviderOptions(
    inheritedProviderOptions,
    profile?.provider,
    options.protocol,
    options.modelId,
  )
  const capabilities: ModelCapabilities = {
    ...base,
    supportsNativeTools,
    supportsImageInput,
    // 合成小图挑战不能证明自定义网关可稳定接收 20 MB 原图。
    supportsOriginalImageDetail: undefined,
    reasoningExposure: isReasoningDisabled(options.modelId)
      ? 'none'
      : base.reasoningExposure,
    structuredOutput: profile?.capabilities.structuredOutput
      ?? (supportsNativeTools ? 'tool-based' : 'prompt'),
  }

  return {
    id: options.id,
    displayName: options.connectionName,
    provider: profile?.provider ?? 'custom',
    protocol: options.protocol,
    capabilities,
    ...(providerOptions ? { providerOptions } : {}),
    create: (config) => {
      if (!config.baseURL) throw new Error('自定义连接缺少 Base URL')
      if (options.protocol === 'anthropic-messages') {
        return createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL })(options.modelId)
      }
      if (options.protocol === 'openai-responses') {
        return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }).responses(options.modelId)
      }
      return createOpenAICompatible({
        name: adapterName,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      })(options.modelId)
    },
  }
}

function resolveCustomProviderOptions(
  inherited: ModelEntry['providerOptions'],
  provider: ModelEntry['provider'] | undefined,
  protocol: CustomApiProtocol,
  modelId: string,
): ModelEntry['providerOptions'] {
  if (!inherited || provider !== 'openai' || protocol !== 'openai-responses') {
    return inherited
  }
  const suffix = parseCustomModelThinkingSuffix(modelId)
  if (!suffix || !isOpenAIReasoningEffort(suffix.modifier)) return inherited
  return {
    ...inherited,
    openai: {
      ...inherited.openai,
      reasoningEffort: suffix.modifier,
    },
  }
}

function isOpenAIReasoningEffort(value: string): boolean {
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'auto', 'none'].includes(value)
}

function isReasoningDisabled(modelId: string): boolean {
  return parseCustomModelThinkingSuffix(modelId)?.modifier === 'none'
}
