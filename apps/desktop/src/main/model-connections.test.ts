import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { providerOptionsWithReasoningEffort } from '@whycode/core'
import { cliProxyModelId, type WhycodeConfig } from './config.ts'
import { listModelConnections, resolveModelConnection } from './model-connections.ts'

describe('模型连接解析', () => {
  it('内置厂商的官方端点与协议兼容中转共用注册模型能力', () => {
    const official = resolveModelConnection(
      config({ anthropic: { apiKey: 'key' } }),
      'anthropic:claude-sonnet-4-6',
    )
    const relay = resolveModelConnection(
      config({ anthropic: { apiKey: 'key', baseURL: 'http://127.0.0.1:8080/v1' } }),
      'anthropic:claude-sonnet-4-6',
    )
    assert.equal(official.ok && official.value.entry.capabilities.supportsImageInput, true)
    assert.equal(relay.ok && relay.value.entry.capabilities.supportsImageInput, true)
  })

  it('CLIProxyAPI 使用独立连接身份并严格继承所选注册型号画像', () => {
    const value = withCliProxy(
      ['openai:gpt-5.6-sol'],
      { openai: { apiKey: 'official-key' } },
    )
    const proxyId = cliProxyModelId('openai:gpt-5.6-sol')
    const result = resolveModelConnection(value, proxyId)
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.entry.id, proxyId)
      assert.equal(result.value.entry.displayName, 'GPT-5.6 Sol（CLIProxyAPI）')
      assert.deepEqual(result.value.entry.capabilities.reasoningEffort, {
        supported: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
        default: 'medium',
      })
      assert.deepEqual(result.value.providerConfig, {
        apiKey: 'proxy-key',
        baseURL: 'http://127.0.0.1:8317/v1',
      })
      const created = result.value.entry.create(result.value.providerConfig)
      assert.notEqual(typeof created, 'string')
      if (typeof created !== 'string') assert.equal(created.modelId, 'gpt-5.6-sol')
    }

    const names = listModelConnections(value)
      .filter((item) => item.id.endsWith('openai:gpt-5.6-sol'))
      .map((item) => item.displayName)
    assert.deepEqual(names, ['GPT-5.6 Sol', 'GPT-5.6 Sol（CLIProxyAPI）'])
  })

  it('CLIProxyAPI 不接受未启用或未注册的模型', () => {
    const value = withCliProxy(['openai:gpt-5.6-sol'])
    const disabled = resolveModelConnection(
      value,
      cliProxyModelId('google:gemini-3.1-pro-preview'),
    )
    assert.equal(disabled.ok, false)
    if (!disabled.ok) assert.match(disabled.error, /尚未启用 Gemini 3.1 Pro Preview/)

    const otherProvider = resolveModelConnection(
      value,
      cliProxyModelId('deepseek:deepseek-v4-flash'),
    )
    assert.equal(otherProvider.ok, false)
    if (!otherProvider.ok) assert.match(otherProvider.error, /尚未适配 DeepSeek V4 Flash/)

    const unknown = resolveModelConnection(value, cliProxyModelId('unknown:model'))
    assert.equal(unknown.ok, false)
    if (!unknown.ok) assert.match(unknown.error, /已不再支持模型/)
  })

  it('退役模型只作为当前历史红色占位，不自动解析为替代型号', () => {
    const value = config({ google: { apiKey: 'key' } })
    value.retiredModelLabels = { 'custom:old-route': 'legacy-model(high)' }
    const retiredId = 'custom:old-route'
    const resolution = resolveModelConnection(value, retiredId)
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.match(resolution.error, /WhyCode 已不再支持模型/)
      assert.match(resolution.error, /历史对话仍会保留/)
    }

    const item = listModelConnections(value, retiredId).at(-1)
    assert.equal(item?.id, retiredId)
    assert.equal(item?.displayName, 'legacy-model(high)')
    assert.equal(item?.available, false)
    assert.equal(item?.retired, true)
    assert.equal(
      listModelConnections(value).some((candidate) => candidate.id === retiredId),
      false,
    )
  })

  it('当前仍受支持但未启用的 CLIProxyAPI 历史不是退役型号', () => {
    const modelId = cliProxyModelId('google:gemini-3.1-pro-preview')
    const item = listModelConnections(config({}), modelId).at(-1)
    assert.equal(item?.displayName, 'Gemini 3.1 Pro Preview（CLIProxyAPI）')
    assert.equal(item?.available, false)
    assert.equal(item?.retired, false)
    assert.match(item?.unavailableReason ?? '', /尚未启用/)
  })

  it('不会把 CLIProxyAPI 的 Gemini 3.5 路由伪装成 Gemini 3.6', () => {
    const modelId = cliProxyModelId('google:gemini-3.6-flash')
    const resolution = resolveModelConnection(withCliProxy([
      'google:gemini-3.6-flash',
    ]), modelId)
    assert.equal(resolution.ok, false)
    if (!resolution.ok) {
      assert.match(resolution.error, /没有 Gemini 3.6 等价路由/)
      assert.match(resolution.error, /gemini-3-flash-agent 实际是 Gemini 3.5/)
    }

    const item = listModelConnections(config({}), modelId).at(-1)
    assert.equal(item?.displayName, 'Gemini 3.6 Flash（CLIProxyAPI）')
    assert.equal(item?.available, false)
    assert.equal(item?.retired, true)
  })

  it('模型列表只暴露逐型号验证过的推理档位', () => {
    const item = listModelConnections(
      withCliProxy(['google:gemini-3.1-pro-preview']),
    ).find((candidate) => candidate.id === cliProxyModelId('google:gemini-3.1-pro-preview'))
    assert.deepEqual(item?.reasoningEffort, {
      supported: ['low', 'medium', 'high'],
      default: 'high',
    })
  })

  it('CLIProxyAPI 连接按所选型号和协议生成实际推理参数', () => {
    const cases = [
      ['anthropic:claude-sonnet-4-6', 'max', 'anthropic', 'effort'],
      ['google:gemini-3.1-pro-preview', 'high', 'google', 'reasoningEffort'],
      ['openai:gpt-5.6-sol', 'xhigh', 'openai', 'reasoningEffort'],
    ] as const
    const value = withCliProxy(cases.map(([modelId]) => modelId))

    for (const [baseModelId, effort, providerKey, optionKey] of cases) {
      const result = resolveModelConnection(value, cliProxyModelId(baseModelId))
      assert.equal(result.ok, true, baseModelId)
      if (!result.ok) continue
      const options = providerOptionsWithReasoningEffort(result.value.entry, effort)
      assert.equal(options?.[providerKey]?.[optionKey], effort, baseModelId)
    }
  })
})

function config(providers: WhycodeConfig['providers']): WhycodeConfig {
  return { providers }
}

function withCliProxy(
  modelIds: string[],
  providers: WhycodeConfig['providers'] = {},
): WhycodeConfig {
  return {
    providers,
    cliProxyApi: {
      apiKey: 'proxy-key',
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds,
    },
  }
}
