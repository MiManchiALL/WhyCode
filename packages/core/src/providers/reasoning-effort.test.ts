import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getModelEntry } from './registry.ts'
import {
  normalizeReasoningEffortSelection,
  providerOptionsWithReasoningEffort,
} from './reasoning-effort.ts'

describe('推理强度协议适配', () => {
  it('default 不覆盖厂商参数，显式档位按 Responses 与 Messages 协议翻译', () => {
    const gpt = getModelEntry('openai:gpt-5.6-sol')
    assert.deepEqual(providerOptionsWithReasoningEffort(gpt, 'default'), {
      openai: { forceReasoning: true, reasoningSummary: 'auto', store: false },
    })
    assert.deepEqual(providerOptionsWithReasoningEffort(gpt, 'xhigh'), {
      openai: {
        forceReasoning: true,
        reasoningSummary: 'auto',
        store: false,
        reasoningEffort: 'xhigh',
      },
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

  it('OpenAI Chat 兼容厂商使用各自 provider key 的 reasoning_effort', () => {
    const gemini = getModelEntry('google:gemini-3.7-flash')
    assert.deepEqual(providerOptionsWithReasoningEffort(gemini, 'low'), {
      google: {
        extra_body: {
          google: { thinking_config: { include_thoughts: true } },
        },
        reasoningEffort: 'low',
      },
    })

    const deepseek = getModelEntry('deepseek:deepseek-v4-pro')
    assert.deepEqual(providerOptionsWithReasoningEffort(deepseek, 'max'), {
      deepseek: {
        thinking: { type: 'enabled' },
        reasoningEffort: 'max',
      },
    })
  })

  it('不支持的档位回到默认，绕过 UI 强传时仍 fail-closed', () => {
    const gemini = getModelEntry('google:gemini-3.7-flash')
    assert.equal(normalizeReasoningEffortSelection(gemini.capabilities, 'max'), 'default')
    assert.throws(
      () => providerOptionsWithReasoningEffort(gemini, 'max'),
      /不支持推理强度 max/,
    )
  })
})
