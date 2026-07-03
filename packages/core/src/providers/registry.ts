import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import type { LanguageModel } from 'ai'

/**
 * 模型能力标记 —— 提示词条件 section、结构化输出分层、thinking 处理都依据这里。
 * 见 docs/03-提示词与数据契约.md。
 */
export interface ModelCapabilities {
  /** 原生 function calling 是否可靠可用（false 时走 XML fallback，暂未实现） */
  supportsNativeTools: boolean
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
}

export interface ProviderConfig {
  apiKey: string
  /** 自定义端点（自建网关/代理场景） */
  baseURL?: string
}

/** M1 首批模型注册表：Anthropic + DeepSeek（OpenAI/智谱 M1 后半段补） */
export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    id: 'anthropic:claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    capabilities: {
      supportsNativeTools: true,
      reasoningExposure: 'block',
      structuredOutput: 'json-schema',
      promptCaching: 'explicit',
      contextWindow: 200_000,
      maxOutput: 64_000,
    },
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
] as const

export function getModelEntry(modelId: string): ModelEntry {
  const entry = MODEL_REGISTRY.find((m) => m.id === modelId)
  if (!entry) {
    throw new Error(`未注册的模型 ID: ${modelId}`)
  }
  return entry
}
