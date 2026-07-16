import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createCustomModelEntry } from './custom.ts'

describe('自定义连接有效能力', () => {
  it('严格匹配型号后继承固有画像，并用端点探测收紧图片能力', () => {
    const entry = createCustomModelEntry({
      id: 'custom:one',
      connectionName: 'MiMo 网关',
      protocol: 'openai-chat',
      modelId: 'MiMo - V2.5',
      probe: { text: 'supported', tools: 'supported', image: 'unsupported' },
    })
    assert.equal(entry.provider, 'mimo')
    assert.equal(entry.capabilities.contextWindow, 1_048_576)
    assert.equal(entry.capabilities.supportsNativeTools, true)
    assert.equal(entry.capabilities.supportsImageInput, false)
    assert.equal(entry.capabilities.supportsOriginalImageDetail, undefined)
  })

  it('自定义 MiMo 图片检测通过后仍不夸大为 original 大图能力', () => {
    const entry = createCustomModelEntry({
      id: 'custom:mimo-image',
      connectionName: 'MiMo 图片网关',
      protocol: 'openai-chat',
      modelId: 'mimo-v2.5',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.equal(entry.capabilities.supportsImageInput, true)
    assert.equal(entry.capabilities.supportsOriginalImageDetail, undefined)
  })

  it('未知型号采用保守默认，但允许经实测开放工具和图片', () => {
    const entry = createCustomModelEntry({
      id: 'custom:two',
      connectionName: '内部模型',
      protocol: 'openai-chat',
      modelId: 'internal-vision-1',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.equal(entry.provider, 'custom')
    assert.equal(entry.capabilities.contextWindow, 32_000)
    assert.equal(entry.capabilities.maxOutput, 8_000)
    assert.equal(entry.capabilities.reasoningExposure, 'none')
    assert.equal(entry.capabilities.supportsNativeTools, true)
    assert.equal(entry.capabilities.supportsImageInput, true)
    assert.equal(entry.capabilities.structuredOutput, 'tool-based')
  })

  it('自定义连接的型号表示有差异时仍继承对应的正式画像', () => {
    const entry = createCustomModelEntry({
      id: 'custom:claude',
      connectionName: '本地 Claude',
      protocol: 'anthropic-messages',
      modelId: 'CLAUDE＿SONNET / 4．6',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.equal(entry.provider, 'anthropic')
    assert.equal(entry.capabilities.contextWindow, 1_000_000)
    assert.equal(entry.capabilities.maxOutput, 64_000)
    assert.equal(entry.capabilities.supportsImageInput, true)
    assert.deepEqual(entry.providerOptions, {
      anthropic: { cacheControl: { type: 'ephemeral' } },
    })
  })

  it('兼容协议与原厂协议不同时不携带协议专属参数', () => {
    const entry = createCustomModelEntry({
      id: 'custom:claude-chat',
      connectionName: 'OpenAI 兼容 Claude',
      protocol: 'openai-chat',
      modelId: 'claude-sonnet-4-6',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.equal(entry.provider, 'anthropic')
    assert.equal(entry.providerOptions, undefined)
  })
})
