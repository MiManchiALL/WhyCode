import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MODEL_CATALOG, getModelProfile } from './catalog.ts'

describe('模型目录单一事实源', () => {
  it('内部 ID、厂商模型 ID 与展示名均保持唯一', () => {
    assert.equal(new Set(MODEL_CATALOG.map((model) => model.id)).size, MODEL_CATALOG.length)
    assert.equal(
      new Set(MODEL_CATALOG.map((model) => `${model.provider}:${model.modelId}`)).size,
      MODEL_CATALOG.length,
    )
    assert.equal(
      new Set(MODEL_CATALOG.map((model) => model.displayName)).size,
      MODEL_CATALOG.length,
    )
  })

  it('只注册当前受支持的精确型号', () => {
    assert.deepEqual(MODEL_CATALOG.map((model) => model.id), [
      'anthropic:claude-sonnet-4-6',
      'deepseek:deepseek-v4-flash',
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.6-flash',
      'mimo:mimo-v2.5',
      'zhipu:glm-5v-turbo',
      'zhipu:glm-4.7',
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
      'openai:gpt-5.6-luna',
      'openai:gpt-5.5',
      'openai:gpt-5.2',
    ])
    assert.throws(
      () => getModelProfile('google:gemini-3.5-flash'),
      /未维护的模型画像/,
    )
  })

  it('可选推理档位都有明确且有效的官方默认值', () => {
    for (const model of MODEL_CATALOG) {
      const effort = model.capabilities.reasoningEffort
      if (!effort) continue
      assert.ok(effort.supported.includes(effort.default), model.id)
      assert.equal(new Set(effort.supported).size, effort.supported.length, model.id)
    }
  })
})
