import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createConnectionSettingsSnapshot,
  updateAuxiliaryModelSettings,
  updateCliProxyApiSettings,
  updateConsensusModelSettings,
  updateProviderSettings,
} from './model-settings.ts'
import type { WhycodeConfig } from './config.ts'
import type { McpSettingsItem } from '../shared/settings.ts'

const emptyMcpSettings: McpSettingsItem = {
  globalConfigPath: 'C:\\Users\\test\\.whycode\\mcp.json',
  currentSessionUsesSnapshot: false,
  servers: [],
  diagnostics: [],
}

function createSettingsSnapshot(config: WhycodeConfig | null) {
  return createConnectionSettingsSnapshot(config, emptyMcpSettings)
}

describe('模型设置数据边界', () => {
  it('设置快照不向 Renderer 返回任何 API key', () => {
    const config: WhycodeConfig = {
      providers: { mimo: { apiKey: 'secret-key' } },
      cliProxyApi: {
        apiKey: 'proxy-secret',
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['openai:gpt-5.6-sol'],
        modelRoutes: { 'openai:gpt-5.6-sol': 'gpt-5.6-sol' },
      },
      webSearch: {
        activeProvider: 'tavily',
        perplexity: { apiKey: 'perplexity-secret' },
        tavily: { apiKey: 'tavily-secret' },
      },
    }
    const snapshot = createSettingsSnapshot(config)
    assert.equal(snapshot.providers.find((item) => item.id === 'mimo')?.hasKey, true)
    assert.equal(snapshot.cliProxyApi.hasKey, true)
    assert.equal(
      snapshot.cliProxyApi.models.find((model) => model.id === 'openai:gpt-5.6-sol')?.enabled,
      true,
    )
    assert.equal(snapshot.webSearch.activeProvider, 'tavily')
    assert.equal(
      snapshot.webSearch.providers.every((provider) => provider.hasKey),
      true,
    )
    assert.doesNotMatch(
      JSON.stringify(snapshot),
      /secret-key|proxy-secret|perplexity-secret|tavily-secret/,
    )
  })

  it('辅助模型分别约束视觉候选和子代理候选，并以 null 表示默认行为', () => {
    const initial: WhycodeConfig = {
      providers: {
        deepseek: { apiKey: 'text-key' },
        google: { apiKey: 'vision-key' },
      },
    }
    const snapshot = createSettingsSnapshot(initial)
    assert.deepEqual(snapshot.auxiliaryModels, {
      visionModelId: null,
      subagentModelId: null,
      visionModels: [
        { id: 'google:gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
        { id: 'google:gemini-3.7-flash', displayName: 'Gemini 3.7 Flash' },
      ],
      subagentModels: [
        { id: 'deepseek:deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
        { id: 'deepseek:deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
        { id: 'google:gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
        { id: 'google:gemini-3.7-flash', displayName: 'Gemini 3.7 Flash' },
      ],
    })

    const enabled = updateAuxiliaryModelSettings(initial, {
      visionModelId: 'google:gemini-3.7-flash',
      subagentModelId: 'deepseek:deepseek-v4-pro',
    })
    assert.deepEqual(enabled.auxiliaryModels, {
      visionModelId: 'google:gemini-3.7-flash',
      subagentModelId: 'deepseek:deepseek-v4-pro',
    })
    assert.equal(
      createSettingsSnapshot(enabled).auxiliaryModels.visionModelId,
      'google:gemini-3.7-flash',
    )
    assert.throws(
      () => updateAuxiliaryModelSettings(initial, {
        visionModelId: 'deepseek:deepseek-v4-flash',
        subagentModelId: null,
      }),
      /视觉辅助模型必须是当前已配置且可用的多模态模型/,
    )
    assert.throws(
      () => updateAuxiliaryModelSettings(initial, {
        visionModelId: null,
        subagentModelId: 'openai:gpt-5.6-sol',
      }),
      /子代理模型必须来自当前已配置且可用的模型连接/,
    )
    assert.deepEqual(
      updateAuxiliaryModelSettings(enabled, {
        visionModelId: null,
        subagentModelId: 'deepseek:deepseek-v4-flash',
      }).auxiliaryModels,
      { subagentModelId: 'deepseek:deepseek-v4-flash' },
    )
    assert.equal(
      updateAuxiliaryModelSettings(enabled, {
        visionModelId: null,
        subagentModelId: null,
      }).auxiliaryModels,
      undefined,
    )
  })

  it('协商 B/C 只保存统一模型连接 ID，不接收独立端点或密钥', () => {
    const initial: WhycodeConfig = {
      providers: {
        deepseek: { apiKey: 'deepseek-key' },
        google: { apiKey: 'google-key' },
      },
    }
    const snapshot = createSettingsSnapshot(initial)
    assert.deepEqual(snapshot.consensusModels, {
      agentBModelId: null,
      agentCModelId: null,
      models: [
        { id: 'deepseek:deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
        { id: 'deepseek:deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
        { id: 'google:gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview' },
        { id: 'google:gemini-3.7-flash', displayName: 'Gemini 3.7 Flash' },
      ],
    })

    const configured = updateConsensusModelSettings(initial, {
      agentBModelId: 'deepseek:deepseek-v4-flash',
      agentCModelId: 'google:gemini-3.7-flash',
    })
    assert.deepEqual(configured.consensusAgents, {
      B: { modelId: 'deepseek:deepseek-v4-flash' },
      C: { modelId: 'google:gemini-3.7-flash' },
    })
    assert.deepEqual(createSettingsSnapshot(configured).consensusModels, {
      agentBModelId: 'deepseek:deepseek-v4-flash',
      agentCModelId: 'google:gemini-3.7-flash',
      models: snapshot.consensusModels.models,
    })
    assert.throws(
      () => updateConsensusModelSettings(initial, {
        agentBModelId: 'openai:gpt-5.6-sol',
        agentCModelId: null,
      }),
      /必须来自当前已配置且可用的模型连接/,
    )
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

  it('CLIProxyAPI 只接受兼容型号并按目录顺序保存，路由等待实例发现', () => {
    const next = updateCliProxyApiSettings(null, {
      baseURL: 'http://127.0.0.1:8317/v1/',
      apiKey: 'proxy-key',
      modelIds: ['openai:gpt-5.6-sol', 'anthropic:claude-sonnet-4-6'],
    })
    assert.deepEqual(next.cliProxyApi, {
      apiKey: 'proxy-key',
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds: ['anthropic:claude-sonnet-4-6', 'openai:gpt-5.6-sol'],
      modelRoutes: {},
    })
    assert.throws(
      () => updateCliProxyApiSettings(next, {
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['unknown:model'],
      }),
      /只能选择已确认存在等价路由的 WhyCode 模型/,
    )
    const gemini = updateCliProxyApiSettings(next, {
      baseURL: 'http://127.0.0.1:8317/v1',
      modelIds: ['google:gemini-3.7-flash'],
    })
    assert.deepEqual(gemini.cliProxyApi?.modelIds, ['google:gemini-3.7-flash'])
    assert.deepEqual(gemini.cliProxyApi?.modelRoutes, {})
  })

  it('CLIProxyAPI 清除密钥时保留地址和型号，但移除失效默认连接', () => {
    const initial: WhycodeConfig = {
      providers: {},
      defaultModel: 'cliproxyapi:openai:gpt-5.6-sol',
      cliProxyApi: {
        apiKey: 'proxy-key',
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: ['openai:gpt-5.6-sol'],
        modelRoutes: { 'openai:gpt-5.6-sol': 'gpt-5.6-sol' },
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
    assert.deepEqual(next.cliProxyApi?.modelRoutes, {})
    assert.equal(next.defaultModel, undefined)
  })

  it('设置快照展示最新目录及精确推理档位', () => {
    const snapshot = createSettingsSnapshot({ providers: {} })
    const openai = snapshot.providers.find((item) => item.id === 'openai')
    const google = snapshot.providers.find((item) => item.id === 'google')
    const claudeProxy = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'anthropic:claude-sonnet-4-6',
    )
    const gemini37Proxy = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'google:gemini-3.7-flash',
    )
    assert.deepEqual(openai?.models.map((model) => model.id), [
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
      'openai:gpt-5.6-luna',
      'openai:gpt-5.5',
    ])
    assert.equal(google?.displayName, 'Google Gemini')
    assert.deepEqual(google?.models.map((model) => model.id), [
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.7-flash',
    ])
    assert.deepEqual(claudeProxy?.capabilities.reasoningEffort, {
      supported: ['low', 'medium', 'high', 'max'],
      default: 'high',
    })
    assert.equal(claudeProxy?.capabilities.contextWindow, 200_000)
    assert.deepEqual(snapshot.cliProxyApi.models.map((model) => model.id), [
      'anthropic:claude-sonnet-4-6',
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.7-flash',
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
      'openai:gpt-5.6-luna',
      'openai:gpt-5.5',
    ])
    assert.deepEqual(gemini37Proxy?.capabilities.reasoningEffort, {
      supported: ['low', 'medium', 'high'],
      default: 'high',
    })
    assert.equal(
      snapshot.cliProxyApi.models.some((model) => model.id.startsWith('deepseek:')),
      false,
    )
  })

  it('设置快照按当前实例的精确路由展示 CLIProxyAPI 有效画像', () => {
    const snapshot = createSettingsSnapshot({
      providers: {},
      cliProxyApi: {
        apiKey: 'proxy-key',
        baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: [
          'google:gemini-3.1-pro-preview',
          'google:gemini-3.7-flash',
          'openai:gpt-5.6-sol',
        ],
        modelRoutes: {
          'google:gemini-3.1-pro-preview': 'gemini-3.1-pro-low',
          'google:gemini-3.7-flash': 'gemini-3.7-flash-high',
          'openai:gpt-5.6-sol': 'gpt-5.6-sol',
          'openai:gpt-5.6-terra': 'gpt-5.6-terra',
        },
      },
    })
    const gemini = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'google:gemini-3.1-pro-preview',
    )
    const gemini37 = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'google:gemini-3.7-flash',
    )
    const gpt = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'openai:gpt-5.6-sol',
    )
    const terra = snapshot.cliProxyApi.models.find(
      (model) => model.id === 'openai:gpt-5.6-terra',
    )
    assert.equal(gemini?.capabilities.reasoningEffort?.default, 'low')
    assert.equal(gemini?.capabilities.maxOutput, 65_535)
    assert.equal(gemini37?.capabilities.reasoningEffort?.default, 'high')
    assert.equal(gemini37?.capabilities.maxOutput, 65_536)
    assert.equal(gpt?.capabilities.contextWindow, 372_000)
    assert.equal(gpt?.capabilities.reasoningEffort?.supported.includes('none'), false)
    assert.equal(terra?.enabled, false)
    assert.deepEqual(snapshot.cliProxyApi.models.map((model) => model.id), [
      'google:gemini-3.1-pro-preview',
      'google:gemini-3.7-flash',
      'openai:gpt-5.6-sol',
      'openai:gpt-5.6-terra',
    ])
  })
})
