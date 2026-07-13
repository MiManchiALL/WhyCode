import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel, ProviderMetadata } from 'ai'

/**
 * 模型能力标记 —— 提示词条件 section、结构化输出分层、thinking 处理都依据这里。
 * 见 docs/03-提示词与数据契约.md。
 */
export interface ModelCapabilities {
  /** 原生 function calling 是否可靠可用（false 时走 XML fallback，暂未实现） */
  supportsNativeTools: boolean
  /** 是否允许在 user message 中发送图片；未知或未验证的接入一律标 false。 */
  supportsImageInput: boolean
  /** reasoning 暴露方式：block=Anthropic thinking block；field=reasoning_content 字段；summary=仅摘要；none=无 */
  reasoningExposure: 'block' | 'field' | 'summary' | 'none'
  /** 结构化输出最高档位，对应文档三 §2.2 的四级协商 */
  structuredOutput: 'json-schema' | 'tool-based' | 'json-object' | 'prompt'
  /** prompt cache：explicit=需手动断点（Anthropic）；auto=自动；none=无 */
  promptCaching: 'explicit' | 'auto' | 'none'
  /** 上下文窗口（token） */
  contextWindow: number
  /** 单次响应最大输出 token */
  maxOutput: number
}

export interface ModelEntry {
  /** WhyCode 内部模型 ID，格式 provider:model */
  id: string
  displayName: string
  provider: 'anthropic' | 'deepseek' | 'openai' | 'zhipu'
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

/** 内置模型注册表；后续做设置界面时允许用户自定义增删。 */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    id: 'anthropic:claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'block',
      structuredOutput: 'json-schema',
      promptCaching: 'explicit',
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    create: (config) =>
      createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL })(
        'claude-sonnet-4-6',
      ),
  },
  {
    id: 'deepseek:deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    provider: 'deepseek',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'field',
      structuredOutput: 'json-object',
      promptCaching: 'auto',
      contextWindow: 128_000,
      maxOutput: 32_000,
    },
    create: (config) =>
      createDeepSeek({ apiKey: config.apiKey, baseURL: config.baseURL })(
        'deepseek-v4-flash',
      ),
  },
  {
    id: 'zhipu:glm-5v-turbo',
    displayName: 'GLM-5V-Turbo',
    provider: 'zhipu',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'auto',
      contextWindow: 200_000,
      maxOutput: 128_000,
    },
    // 首选视觉模型也先关闭 thinking，保持现有“工具调用后继续回答”的稳定循环。
    providerOptions: { zhipu: { thinking: { type: 'disabled' } } },
    create: (config) =>
      createOpenAICompatible({
        name: 'zhipu',
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? 'https://open.bigmodel.cn/api/paas/v4',
      })('glm-5v-turbo'),
  },
  {
    id: 'zhipu:glm-4.7',
    displayName: 'GLM-4.7',
    provider: 'zhipu',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      // GLM-4.7 thinking+工具调用会把最终答案吞进 reasoning_content（两种协议端点均复现，2026-07-04），
      // 暂关 thinking 保工具循环可用，等厂商修复后恢复（见便签）
      reasoningExposure: 'none',
      structuredOutput: 'json-schema',
      promptCaching: 'auto',
      contextWindow: 128_000,
      maxOutput: 32_000,
    },
    providerOptions: { zhipu: { thinking: { type: 'disabled' } } },
    // 智谱兼容 OpenAI 协议但路径是 /api/paas/v4（不是 /v1），用 openai-compatible 显式指 baseURL
    create: (config) =>
      createOpenAICompatible({
        name: 'zhipu',
        apiKey: config.apiKey,
        baseURL: config.baseURL ?? 'https://open.bigmodel.cn/api/paas/v4',
      })('glm-4.7'),
  },
  {
    id: 'openai:gpt-5.2',
    displayName: 'GPT-5.2',
    provider: 'openai',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'summary',
      structuredOutput: 'json-schema',
      promptCaching: 'auto',
      contextWindow: 400_000,
      maxOutput: 128_000,
    },
    create: (config) =>
      createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL })('gpt-5.2'),
  },
] as const

export function getModelEntry(modelId: string): ModelEntry {
  const entry = MODEL_REGISTRY.find((m) => m.id === modelId)
  if (!entry) {
    throw new Error(`未注册的模型 ID: ${modelId}`)
  }
  return entry
}
