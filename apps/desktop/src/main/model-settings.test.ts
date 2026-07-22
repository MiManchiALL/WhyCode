import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createModelSettingsSnapshot,
  updateCliProxyApiSettings,
  updateProviderSettings,
} from './model-settings.ts'
import type { WhycodeConfig } from './config.ts'

describe('模型设置数据边界', () => {
  it('设置快照不向 Renderer 返回任何 API key', () => {
    const config: WhycodeConfig = {
      providers: { mimo: { apiKey: 'secret-key' } },
      cliProxyApi: {
        apiKey: 'proxy-secret',
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['openai:gpt-5.6-sol'],
      },
      webSearch: { perplexity: { apiKey: 'search-secret' } },
    }
    const snapshot = createModelSettingsSnapshot(config)
    assert.equal(snapshot.providers.find((item) => item.id === 'mimo')?.hasKey, true)
    assert.equal(snapshot.cliProxyApi.hasKey, true)
    assert.equal(
      snapshot.cliProxyApi.models.find((model) => model.id === 'openai:gpt-5.6-sol')?.enabled,
      true,
    )
    assert.equal(snapshot.webSearch.hasKey, true)
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-key|proxy-secret|search-secret/)
  })

  it('内置厂商设置支持保留、替换、清除 key 和恢复默认端点', () => {
    const initial: WhycodeConfig = {
      providers: { mimo: { apiKey: 'old', baseURL: 'http://gateway/v1' } },
      defaultModel: 'mimo:mimo-v2.5',
    }
    const preserved = updateProviderSettings(initial, {
      providerId: 'mimo',
      baseURL: '',
    })
    assert.equal(preserved.providers.mimo?.apiKey, 'old')
    assert.equal(preserved.providers.mimo?.baseURL, undefined)

    const cleared = updateProviderSettings(preserved, {
      providerId: 'mimo',
      clearApiKey: true,
    })
    assert.equal(cleared.providers.mimo, undefined)
    assert.equal(cleared.defaultModel, undefined)
  })

  it('CLIProxyAPI 只接受已确认等价路由并按独立兼容目录顺序保存', () => {
    const next = updateCliProxyApiSettings(null, {
      baseURL: 'http://127.0.0.1:8317/v1/',
      apiKey: 'proxy-key',
      modelIds: ['openai:gpt-5.6-sol', 'anthropic:claude-sonnet-4-6'],
    })
    assert.deepEqual(next.cliProxyApi, {
      apiKey: 'proxy-key',
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds: ['anthropic:claude-sonnet-4-6', 'openai:gpt-5.6-sol'],
    })
    assert.throws(
      () => updateCliProxyApiSettings(next, {
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['unknown:model'],
      }),
      /只能选择已确认存在等价路由的 WhyCode 模型/,
    )
    assert.throws(
      () => updateCliProxyApiSettings(next, {
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['google:gemini-3.6-flash'],
      }),
      /只能选择已确认存在等价路由的 WhyCode 模型/,
    )
  })

  it('CLIProxyAPI 清除密钥时保留地址和型号，但移除失效默认连接', () => {
    const initial: WhycodeConfig = {
      providers: {},
      defaultModel: 'cliproxyapi:openai:gpt-5.6-sol',
      cliProxyApi: {
        apiKey: 'proxy-key',
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['openai:gpt-5.6-sol'],
      },
    }
    const next = updateCliProxyApiSettings(initial, {
      baseURL: initial.cliProxyApi!.baseURL,
      clearApiKey: true,
      modelIds: initial.cliProxyApi!.modelIds,
    })
    assert.equal(next.cliProxyApi?.apiKey, '')
    assert.equal(next.cliProxyApi?.baseURL, 'http://127.0.0.1:8317/v1')
    assert.deepEqual(next.cliProxyApi?.modelIds, ['openai:gpt-5.6-sol'])
    assert.equal(next.defaultModel, undefined)
  })

  it('设置快照展示最新目录及精确推理档位', () => {
    const snapshot = createModelSettingsSnapshot({ providers: {} })
    const openai = snapshot.providers.find((item) => item.id === 'openai')
    const google = snapshot.providers.find((item) => item.id === 'google')
    const claudeProxy = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'anthropic:claude-sonnet-4-6',
    )
    const gemini36Proxy = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'google:gemini-3.6-flash',
    )

    assert.deepEqual(openai?.models.map((model) => model.id), [
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
      'openai:gpt-5.6-luna',
      'openai:gpt-5.5',
      'openai:gpt-5.2',
    ])
    assert.equal(google?.displayName, 'Google Gemini')
    assert.deepEqual(google?.models.map((model) => model.id), [
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.6-flash',
    ])
    assert.deepEqual(claudeProxy?.reasoningEffort, {
      supported: ['low', 'medium', 'high', 'max'],
      default: 'high',
    })
    assert.deepEqual(snapshot.cliProxyApi.models.map((model) => model.id), [
      'anthropic:claude-sonnet-4-6',
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.6-flash',
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
      'openai:gpt-5.6-luna',
      'openai:gpt-5.5',
      'openai:gpt-5.2',
    ])
    assert.equal(gemini36Proxy?.available, false)
    assert.match(gemini36Proxy?.unavailableReason ?? '', /实际是 Gemini 3.5/)
    assert.equal(
      snapshot.cliProxyApi.models.some((model) => model.id.startsWith('deepseek:')),
      false,
    )
  })
})
