import type { ProviderMetadata } from 'ai'
import type { ModelCapabilities, ReasoningEffortSelection } from './catalog.ts'
import type { ModelEntry } from './registry.ts'

export function normalizeReasoningEffortSelection(
  capabilities: ModelCapabilities,
  selection: ReasoningEffortSelection,
): ReasoningEffortSelection {
  if (selection === 'default') return selection
  return capabilities.reasoningEffort?.supported.includes(selection)
    ? selection
    : 'default'
}

/** 将会话选档翻译到当前实际客户端协议，目录中的其它 providerOptions 保持不变。 */
export function providerOptionsWithReasoningEffort(
  model: ModelEntry,
  selection: ReasoningEffortSelection,
): ProviderMetadata | undefined {
  const effort = selection === 'default' ? undefined : selection
  if (!effort) return model.providerOptions
  if (!model.capabilities.reasoningEffort?.supported.includes(effort)) {
    throw new Error(`${model.displayName} 不支持推理强度 ${effort}`)
  }

  const providerKey = model.protocol === 'openai-responses'
    ? 'openai'
    : model.protocol === 'anthropic-messages'
      ? 'anthropic'
      : model.provider
  const inherited = model.providerOptions?.[providerKey] ?? {}
  const override = model.protocol === 'anthropic-messages'
    ? { effort }
    : { reasoningEffort: effort }
  return {
    ...model.providerOptions,
    [providerKey]: {
      ...inherited,
      ...override,
    },
  }
}
