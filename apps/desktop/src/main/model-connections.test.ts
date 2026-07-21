import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WhycodeConfig } from './config.ts'
import { listModelConnections, resolveModelConnection } from './model-connections.ts'

describe('模型连接解析', () => {
  it('官方 key-only 使用维护画像，自定义 Base URL 收紧图片能力', () => {
    const official = resolveModelConnection(config({ anthropic: { apiKey: 'key' } }), 'anthropic:claude-sonnet-4-6')
    assert.equal(official.ok && official.value.entry.capabilities.supportsImageInput, true)

    const gateway = resolveModelConnection(
      config({ anthropic: { apiKey: 'key', baseURL: 'http://127.0.0.1:8080/v1' } }),
      'anthropic:claude-sonnet-4-6',
    )
    assert.equal(gateway.ok && gateway.value.entry.capabilities.supportsImageInput, false)
  })

  it('自定义型号接受严格名称变体，并以探测结果形成有效能力', () => {
    const value = config({})
    value.customConnections = [{
      id: 'mimo-gateway',
      name: 'MiMo 网关',
      protocol: 'openai-chat',
      baseURL: 'http://localhost:9000/v1',
      apiKey: 'key',
      modelId: 'MiMo - V2.5',
      probe: { text: 'supported', tools: 'supported', image: 'supported' },
      checkedAt: '2026-07-16T00:00:00.000Z',
    }]
    const result = resolveModelConnection(value, 'custom:mimo-gateway')
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.entry.provider, 'mimo')
      assert.equal(result.value.entry.capabilities.contextWindow, 1_048_576)
      assert.equal(result.value.entry.capabilities.supportsImageInput, true)
      assert.equal(result.value.entry.capabilities.supportsOriginalImageDetail, undefined)
    }
  })

  it('没有通过工具检测的自定义连接保留在列表，但不可选为完整 Agent', () => {
    const value = config({})
    value.customConnections = [{
      id: 'chat-only',
      name: '仅聊天端点',
      protocol: 'openai-chat',
      baseURL: 'http://localhost/v1',
      apiKey: 'key',
      modelId: 'chat-only',
      probe: { text: 'supported', tools: 'unknown', image: 'unknown' },
      checkedAt: '2026-07-16T00:00:00.000Z',
    }]
    const item = listModelConnections(value).find((candidate) => candidate.id === 'custom:chat-only')
    assert.equal(item?.hasKey, true)
    assert.equal(item?.available, false)
    assert.match(item?.unavailableReason ?? '', /工具调用检测/)
  })

  it('退役模型只作为当前历史占位展示，不自动解析为替代型号', () => {
    const value = config({ google: { apiKey: 'key' } })
    const retiredId = 'google:gemini-3.5-flash'
    const resolution = resolveModelConnection(value, retiredId)
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.match(resolution.error, /WhyCode 已不再支持模型/)
      assert.match(resolution.error, /历史对话仍会保留/)
    }

    const item = listModelConnections(value, retiredId).at(-1)
    assert.equal(item?.id, retiredId)
    assert.equal(item?.available, false)
    assert.match(item?.displayName ?? '', /已停止支持/)
    assert.equal(
      listModelConnections(value).some((candidate) => candidate.id === retiredId),
      false,
    )
  })

  it('未配置任何连接时仍优先识别已退役的内置模型', () => {
    const retiredId = 'google:gemini-3.5-flash'
    const resolution = resolveModelConnection(null, retiredId)

    assert.equal(resolution.ok, false)
    if (!resolution.ok) assert.match(resolution.error, /WhyCode 已不再支持模型/)
    assert.match(
      listModelConnections(null, retiredId).at(-1)?.unavailableReason ?? '',
      /WhyCode 已不再支持模型/,
    )
  })

  it('模型列表只暴露已验证的逐型号思考档位', () => {
    const item = listModelConnections(
      config({ google: { apiKey: 'key' } }),
    ).find((candidate) => candidate.id === 'google:gemini-3.6-flash')
    assert.deepEqual(item?.reasoningEffort, {
      supported: ['minimal', 'low', 'medium', 'high'],
      default: 'medium',
    })
  })
})

function config(providers: WhycodeConfig['providers']): WhycodeConfig {
  return { providers }
}
