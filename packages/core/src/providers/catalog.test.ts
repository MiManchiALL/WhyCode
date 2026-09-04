import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { autoCompactThreshold } from '../context/tokens.ts'
import { BUILTIN_PROVIDERS, MODEL_CATALOG, getModelProfile } from './catalog.ts'

// 当前型号与已核实边界的独立预期，只在这里维护；消费层测试只验证装配与筛选。
const expectedProfiles: readonly (readonly [id: string, image: boolean, contextWindow?: number, maxOutput?: number])[] = [
  ['anthropic:claude-sonnet-4-6', true, 1_000_000, 64_000],
  ['deepseek:deepseek-v4-flash', false, 1_000_000, 384_000],
  ['deepseek:deepseek-v4-pro', false, 1_000_000, 384_000],
  ['deepseek:deepseek-v4-flash-vision-exp', true, 1_000_000, 384_000],
  ['google:gemini-3.1-pro-preview', true, 1_048_576, 65_536],
  ['google:gemini-3.8-flash', true, 1_048_576, 65_536],
  ['mimo:mimo-v2.5', true, 1_048_576, 131_072],
  ['zhipu:glm-5v-turbo', true],
  ['zhipu:glm-4.7', false, 200_000, 128_000],
  ['openai:gpt-5.6-sol', true, 1_050_000, 128_000],
  ['openai:gpt-5.6-terra', true, 1_050_000, 128_000],
  ['openai:gpt-5.6-luna', true, 1_050_000, 128_000],
  ['openai:gpt-6-astra', true, 1_050_000, 128_000],
  ['openai:gpt-5.5', true, 1_050_000, 128_000],
]

describe('模型目录单一事实源', () => {
  it('仅登记当前精确型号，内部 ID、厂商 ID 与名称保持唯一', () => {
    assert.deepEqual(MODEL_CATALOG.map((model) => model.id), expectedProfiles.map(([id]) => id))
    assert.deepEqual(MODEL_CATALOG.map((model) => `${model.provider}:${model.modelId}`), expectedProfiles.map(([id]) => id))
    assert.equal(new Set(MODEL_CATALOG.map((model) => model.id)).size, MODEL_CATALOG.length)
    assert.equal(new Set(MODEL_CATALOG.map((model) => `${model.provider}:${model.modelId}`)).size, MODEL_CATALOG.length)
    assert.equal(new Set(MODEL_CATALOG.map((model) => model.displayName)).size, MODEL_CATALOG.length)
    assert.throws(() => getModelProfile('test:retired-model'), /未维护的模型画像/)
  })

  it('保留各型号图片与长度边界，厂商协议独立于模型版本', () => {
    assert.deepEqual(Object.fromEntries(BUILTIN_PROVIDERS.map((provider) => [provider.id, provider.protocol])), {
      anthropic: 'anthropic-messages', deepseek: 'openai-chat', google: 'openai-chat',
      mimo: 'openai-chat', openai: 'openai-responses', zhipu: 'openai-chat',
    })
    for (const [id, image, contextWindow, maxOutput] of expectedProfiles) {
      const capabilities = getModelProfile(id).capabilities
      assert.equal(capabilities.supportsImageInput, image, id)
      if (contextWindow !== undefined) assert.equal(capabilities.contextWindow, contextWindow, id)
      if (maxOutput !== undefined) assert.equal(capabilities.maxOutput, maxOutput, id)
    }
  })

  it('推理闭集的默认值有效，保留厂商特有参数与能力差异', () => {
    for (const model of MODEL_CATALOG) {
      const effort = model.capabilities.reasoningEffort
      if (effort) {
        assert.ok(effort.supported.includes(effort.default), model.id)
        assert.equal(new Set(effort.supported).size, effort.supported.length, model.id)
      }
      if (model.provider === 'openai') {
        assert.equal(model.capabilities.supportsNativeTools, true)
        assert.equal(model.capabilities.reasoningExposure, 'summary')
        assert.deepEqual(model.providerOptions, {
          openai: { forceReasoning: true, reasoningSummary: 'auto', store: false },
        })
      }
      if (model.provider === 'google') {
        assert.equal(model.capabilities.supportsNativeTools, true)
        assert.equal(model.capabilities.reasoningExposure, 'summary')
        assert.deepEqual(model.providerOptions, {
          google: { extra_body: { google: { thinking_config: { include_thoughts: true } } } },
        })
      }
      if (model.provider === 'deepseek') {
        assert.equal(model.capabilities.supportsNativeTools, true)
        assert.equal(model.capabilities.structuredOutput, 'json-object')
        assert.equal(model.capabilities.promptCaching, 'auto')
        assert.equal(model.capabilities.supportsOriginalImageDetail, undefined)
        assert.equal(autoCompactThreshold(model.capabilities), 910_000)
        assert.deepEqual(effort, {
          supported: model.capabilities.supportsImageInput ? ['low', 'high', 'max'] : ['high', 'max'],
          default: 'high',
        })
        assert.deepEqual(model.providerOptions, { deepseek: { thinking: { type: 'enabled' } } })
      }
    }
    assert.deepEqual(getModelProfile('anthropic:claude-sonnet-4-6').capabilities.reasoningEffort, {
      supported: ['low', 'medium', 'high', 'max'], default: 'high',
    })
    const mimo = getModelProfile('mimo:mimo-v2.5')
    assert.equal(mimo.capabilities.supportsNativeTools, true)
    assert.equal(mimo.capabilities.supportsOriginalImageDetail, true)
    assert.equal(mimo.capabilities.reasoningExposure, 'field')
    assert.deepEqual(mimo.providerOptions, { mimo: { thinking: { type: 'enabled' } } })
  })
})
