import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getBuiltInProvider, MODEL_CATALOG } from './catalog.ts'
import { getModelEntry, MODEL_REGISTRY } from './registry.ts'

describe('MODEL_REGISTRY 目录装配', () => {
  it('完整装配当前目录并复用其能力与参数，不维护第二份画像', () => {
    assert.deepEqual(MODEL_REGISTRY.map((entry) => entry.id), MODEL_CATALOG.map((profile) => profile.id))
    for (const profile of MODEL_CATALOG) {
      const entry = getModelEntry(profile.id)
      assert.equal(entry.displayName, profile.displayName)
      assert.equal(entry.provider, profile.provider)
      assert.equal(entry.protocol, getBuiltInProvider(profile.provider).protocol)
      assert.equal(entry.capabilities, profile.capabilities)
      assert.equal(entry.providerOptions, profile.providerOptions)
    }
  })

  it('各协议工厂使用官方 wire ID，路由覆盖不改变画像身份', () => {
    for (const profile of MODEL_CATALOG) {
      const entry = getModelEntry(profile.id)
      for (const wireModelId of [undefined, 'verified-route']) {
        const model = entry.create(
          { apiKey: 'test', baseURL: 'http://localhost/v1' },
          wireModelId ? { wireModelId } : undefined,
        )
        assert.notEqual(typeof model, 'string')
        if (typeof model !== 'string') assert.equal(model.modelId, wireModelId ?? profile.modelId)
        assert.equal(entry.id, profile.id)
      }
    }
    assert.throws(() => getModelEntry('test:retired-model'), /未注册的模型 ID/)
  })
})
