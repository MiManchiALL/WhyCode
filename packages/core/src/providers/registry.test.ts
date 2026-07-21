import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { autoCompactThreshold } from '../context/tokens.ts'
import { getModelEntry, MODEL_REGISTRY } from './registry.ts'

describe('MODEL_REGISTRY 能力边界', () => {
  it('只给目录中明确支持的官方模型开放图片输入', () => {
    const visualModelIds = MODEL_REGISTRY
      .filter((entry) => entry.capabilities.supportsImageInput)
      .map((entry) => entry.id)

    assert.deepEqual(visualModelIds, [
      'anthropic:claude-sonnet-4-6',
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.6-flash',
      'mimo:mimo-v2.5',
      'zhipu:glm-5v-turbo',
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
      'openai:gpt-5.6-luna',
      'openai:gpt-5.5',
      'openai:gpt-5.2',
    ])
  })

  it('Claude、GLM 与 GPT 使用各自维护的官方输入和长度边界', () => {
    const claude = getModelEntry('anthropic:claude-sonnet-4-6')
    assert.equal(claude.capabilities.supportsImageInput, true)
    assert.equal(claude.capabilities.contextWindow, 1_000_000)
    assert.equal(claude.capabilities.maxOutput, 64_000)
    assert.deepEqual(claude.capabilities.reasoningEffort, {
      supported: ['low', 'medium', 'high', 'max'],
      default: 'high',
    })

    const glm = getModelEntry('zhipu:glm-4.7')
    assert.equal(glm.capabilities.supportsImageInput, false)
    assert.equal(glm.capabilities.contextWindow, 200_000)
    assert.equal(glm.capabilities.maxOutput, 128_000)

    const gpt = getModelEntry('openai:gpt-5.2')
    assert.equal(gpt.capabilities.supportsImageInput, true)
    assert.equal(gpt.capabilities.contextWindow, 400_000)
    assert.equal(gpt.capabilities.maxOutput, 128_000)
  })

  it('MiMo V2.5 使用官方多模态模型与长度边界', () => {
    const mimo = getModelEntry('mimo:mimo-v2.5')
    assert.equal(mimo.provider, 'mimo')
    assert.equal(mimo.protocol, 'openai-chat')
    assert.equal(mimo.capabilities.supportsNativeTools, true)
    assert.equal(mimo.capabilities.supportsImageInput, true)
    assert.equal(mimo.capabilities.supportsOriginalImageDetail, true)
    assert.equal(mimo.capabilities.reasoningExposure, 'field')
    assert.equal(mimo.capabilities.contextWindow, 1_048_576)
    assert.equal(mimo.capabilities.maxOutput, 131_072)
    assert.deepEqual(mimo.providerOptions, {
      mimo: { thinking: { type: 'enabled' } },
    })
  })

  it('Gemini 模型使用 Google OpenAI 兼容协议', () => {
    for (const modelId of [
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.6-flash',
    ]) {
      const gemini = getModelEntry(modelId)
      assert.equal(gemini.provider, 'google')
      assert.equal(gemini.protocol, 'openai-chat')
      assert.equal(gemini.capabilities.supportsNativeTools, true)
      assert.equal(gemini.capabilities.supportsImageInput, true)
      assert.equal(gemini.capabilities.reasoningExposure, 'summary')
      assert.equal(gemini.capabilities.contextWindow, 1_048_576)
      assert.equal(gemini.capabilities.maxOutput, 65_536)
      assert.ok(gemini.capabilities.reasoningEffort)
      const created = gemini.create({ apiKey: 'test', baseURL: 'http://localhost/v1' })
      assert.notEqual(typeof created, 'string')
      if (typeof created !== 'string') {
        assert.equal(created.modelId, modelId.slice('google:'.length))
      }
      assert.deepEqual(gemini.providerOptions, {
        google: {
          extra_body: {
            google: { thinking_config: { include_thoughts: true } },
          },
        },
      })
    }
  })

  it('GPT-5.5 与 GPT-5.6 全系使用 Responses API 和 1M 上下文', () => {
    for (const modelId of [
      'openai:gpt-5.5',
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
      'openai:gpt-5.6-luna',
    ]) {
      const gpt = getModelEntry(modelId)
      assert.equal(gpt.provider, 'openai')
      assert.equal(gpt.protocol, 'openai-responses')
      assert.equal(gpt.capabilities.supportsNativeTools, true)
      assert.equal(gpt.capabilities.supportsImageInput, true)
      assert.equal(gpt.capabilities.reasoningExposure, 'summary')
      assert.equal(gpt.capabilities.contextWindow, 1_050_000)
      assert.equal(gpt.capabilities.maxOutput, 128_000)
      assert.deepEqual(gpt.providerOptions, {
        openai: {
          reasoningSummary: 'auto',
          store: false,
        },
      })
      const created = gpt.create({ apiKey: 'test', baseURL: 'http://localhost/v1' })
      assert.notEqual(typeof created, 'string')
      if (typeof created !== 'string') {
        assert.equal(created.modelId, modelId.slice('openai:'.length))
      }
    }
  })

  it('原生多模态工具结果协议由目录显式维护', () => {
    assert.equal(
      getModelEntry('anthropic:claude-sonnet-4-6').protocol,
      'anthropic-messages',
    )
    assert.equal(getModelEntry('openai:gpt-5.2').protocol, 'openai-responses')
    assert.equal(getModelEntry('openai:gpt-5.6-sol').protocol, 'openai-responses')
    assert.equal(getModelEntry('openai:gpt-5.6-terra').protocol, 'openai-responses')
    assert.equal(getModelEntry('openai:gpt-5.6-luna').protocol, 'openai-responses')
    assert.equal(getModelEntry('google:gemini-3.6-flash').protocol, 'openai-chat')
  })

  it('DeepSeek V4 Flash 使用官方上下文与输出边界', () => {
    const deepseek = getModelEntry('deepseek:deepseek-v4-flash')
    assert.equal(deepseek.capabilities.contextWindow, 1_000_000)
    assert.equal(deepseek.capabilities.maxOutput, 384_000)
    assert.equal(autoCompactThreshold(deepseek.capabilities), 910_000)
  })
})
