import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getModelEntry, MODEL_REGISTRY } from './registry.ts'

describe('MODEL_REGISTRY 图片能力', () => {
  it('只给明确支持并显式接入的视觉模型开放图片输入', () => {
    const visualModelIds = MODEL_REGISTRY
      .filter((entry) => entry.capabilities.supportsImageInput)
      .map((entry) => entry.id)

    assert.deepEqual(visualModelIds, [
      'mimo:mimo-v2.5',
      'zhipu:glm-5v-turbo',
    ])
  })

  it('MiMo V2.5 使用官方多模态模型与长度边界', () => {
    const mimo = getModelEntry('mimo:mimo-v2.5')
    assert.equal(mimo.provider, 'mimo')
    assert.equal(mimo.capabilities.supportsNativeTools, true)
    assert.equal(mimo.capabilities.supportsImageInput, true)
    assert.equal(mimo.capabilities.contextWindow, 1_048_576)
    assert.equal(mimo.capabilities.maxOutput, 131_072)
    assert.deepEqual(mimo.providerOptions, {
      mimo: { thinking: { type: 'disabled' } },
    })
  })
})
