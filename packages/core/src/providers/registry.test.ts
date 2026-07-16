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
      'mimo:mimo-v2.5',
      'zhipu:glm-5v-turbo',
      'openai:gpt-5.2',
    ])
  })

  it('Claude、GLM 与 GPT 使用各自维护的官方输入和长度边界', () => {
    const claude = getModelEntry('anthropic:claude-sonnet-4-6')
    assert.equal(claude.capabilities.supportsImageInput, true)
    assert.equal(claude.capabilities.contextWindow, 1_000_000)
    assert.equal(claude.capabilities.maxOutput, 64_000)

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

  it('DeepSeek V4 Flash 使用官方上下文与输出边界', () => {
    const deepseek = getModelEntry('deepseek:deepseek-v4-flash')
    assert.equal(deepseek.capabilities.contextWindow, 1_000_000)
    assert.equal(deepseek.capabilities.maxOutput, 384_000)
    assert.equal(autoCompactThreshold(deepseek.capabilities), 910_000)
  })
})
