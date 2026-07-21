import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCustomModelEntry } from './custom.ts'
import { getModelEntry } from './registry.ts'
import {
  normalizeReasoningEffortSelection,
  providerOptionsWithReasoningEffort,
} from './reasoning-effort.ts'

describe('思考强度协议适配', () => {
  it('default 不覆盖厂商参数，显式档位按 Responses 与 Messages 协议翻译', () => {
    const gpt = getModelEntry('openai:gpt-5.6-sol')
    assert.deepEqual(providerOptionsWithReasoningEffort(gpt, 'default'), {
      openai: { reasoningSummary: 'auto', store: false },
    })
    assert.deepEqual(providerOptionsWithReasoningEffort(gpt, 'xhigh'), {
      openai: { reasoningSummary: 'auto', store: false, reasoningEffort: 'xhigh' },
    })

    const claude = getModelEntry('anthropic:claude-sonnet-4-6')
    assert.deepEqual(providerOptionsWithReasoningEffort(claude, 'medium'), {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
        thinking: { type: 'adaptive' },
        effort: 'medium',
      },
    })
  })

  it('OpenAI Chat 兼容中转使用 reasoning_effort，不套用原厂 Messages 字段', () => {
    const entry = createCustomModelEntry({
      id: 'custom:claude-chat',
      connectionName: 'Claude 中转',
      protocol: 'openai-chat',
      modelId: 'claude-sonnet-4-6',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.deepEqual(providerOptionsWithReasoningEffort(entry, 'low'), {
      anthropic: { reasoningEffort: 'low' },
    })
  })

  it('不支持的档位回到默认，绕过 UI 强传时仍 fail-closed', () => {
    const gemini = getModelEntry('google:gemini-3.6-flash')
    assert.equal(normalizeReasoningEffortSelection(gemini.capabilities, 'max'), 'default')
    assert.throws(
      () => providerOptionsWithReasoningEffort(gemini, 'max'),
      /不支持思考强度 max/,
    )
  })
})
