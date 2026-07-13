import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MODEL_REGISTRY } from './registry.ts'

describe('MODEL_REGISTRY 图片能力', () => {
  it('只给明确支持并显式接入的视觉模型开放图片输入', () => {
    const visualModelIds = MODEL_REGISTRY
      .filter((entry) => entry.capabilities.supportsImageInput)
      .map((entry) => entry.id)

    assert.deepEqual(visualModelIds, ['zhipu:glm-5v-turbo'])
  })
})
