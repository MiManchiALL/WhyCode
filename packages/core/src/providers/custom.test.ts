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
    assert.equal(entry.protocol, 'openai-chat')
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
    assert.equal(entry.protocol, 'anthropic-messages')
    assert.equal(entry.capabilities.contextWindow, 1_000_000)
    assert.equal(entry.capabilities.maxOutput, 64_000)
    assert.equal(entry.capabilities.supportsImageInput, true)
    assert.deepEqual(entry.providerOptions, {
      anthropic: {
        cacheControl: { type: 'ephemeral' },
        thinking: { type: 'adaptive' },
      },
    })
  })

  it('CLIProxyAPI 思考后缀继承画像但原样发送模型 ID', () => {
    const modelId = 'gpt-5.6-sol(medium)'
    const entry = createCustomModelEntry({
      id: 'custom:cli-proxy',
      connectionName: 'CLIProxyAPI',
      protocol: 'openai-responses',
      modelId,
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.equal(entry.provider, 'openai')
    assert.equal(entry.capabilities.contextWindow, 1_050_000)
    assert.equal(entry.capabilities.maxOutput, 128_000)
    assert.equal(entry.capabilities.supportsImageInput, true)
    assert.deepEqual(entry.capabilities.reasoningEffort, {
      supported: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      default: 'medium',
    })
    assert.deepEqual(entry.providerOptions, {
      openai: {
        reasoningEffort: 'medium',
        reasoningSummary: 'auto',
        store: false,
      },
    })

    const model = entry.create({ apiKey: 'test', baseURL: 'http://localhost:8317/v1' })
    assert.notEqual(typeof model, 'string')
    if (typeof model !== 'string') assert.equal(model.modelId, modelId)

    const low = entry.create({ apiKey: 'test', baseURL: 'http://localhost:8317/v1' }, 'low')
    assert.notEqual(typeof low, 'string')
    if (typeof low !== 'string') assert.equal(low.modelId, 'gpt-5.6-sol(low)')
  })

  it('CLIProxyAPI 的 GPT 思考强度覆盖画像默认值，none 同时关闭展示声明', () => {
    const high = createCustomModelEntry({
      id: 'custom:high',
      connectionName: 'CLIProxyAPI high',
      protocol: 'openai-responses',
      modelId: 'gpt-5.6-sol(high)',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.deepEqual(high.providerOptions, {
      openai: {
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        store: false,
      },
    })
    assert.equal(high.capabilities.reasoningEffort?.default, 'high')

    const none = createCustomModelEntry({
      id: 'custom:none',
      connectionName: 'CLIProxyAPI none',
      protocol: 'openai-responses',
      modelId: 'gpt-5.6-sol(none)',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.equal(none.capabilities.reasoningExposure, 'none')
    assert.equal(none.capabilities.reasoningEffort?.default, 'none')
    assert.deepEqual(none.providerOptions, {
      openai: {
        reasoningEffort: 'none',
        reasoningSummary: 'auto',
        store: false,
      },
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

  it('带 CLIProxyAPI 后缀的未知路由开放网关档位，但普通未知型号继续关闭', () => {
    const gateway = createCustomModelEntry({
      id: 'custom:antigravity',
      connectionName: 'Antigravity',
      protocol: 'openai-chat',
      modelId: 'antigravity-gemini-3.6-flash-agent(high)',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
    })
    assert.equal(gateway.provider, 'custom')
    assert.equal(gateway.capabilities.reasoningEffort?.default, 'high')
    assert.deepEqual(gateway.capabilities.reasoningEffort?.supported, [
      'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
    ])
    const low = gateway.create({ apiKey: 'test', baseURL: 'http://localhost:8317/v1' }, 'low')
    assert.notEqual(typeof low, 'string')
    if (typeof low !== 'string') {
      assert.equal(low.modelId, 'antigravity-gemini-3.6-flash-agent(low)')
    }

    const unknown = createCustomModelEntry({
      id: 'custom:plain',
      connectionName: '未知模型',
      protocol: 'openai-chat',
      modelId: 'internal-model',
      probe: { text: 'supported', tools: 'supported', image: 'unsupported' },
    })
    assert.equal(unknown.capabilities.reasoningEffort, undefined)
  })
})
