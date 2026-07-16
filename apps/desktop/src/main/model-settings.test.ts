import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createModelSettingsSnapshot,
  deleteCustomConnection,
  testAndUpdateCustomConnection,
  updateProviderSettings,
} from './model-settings.ts'
import type { WhycodeConfig } from './config.ts'

describe('模型设置数据边界', () => {
  it('设置快照不向 Renderer 返回 API key', () => {
    const config: WhycodeConfig = {
      providers: { mimo: { apiKey: 'secret-key' } },
      customConnections: [{
        id: 'one',
        name: 'MiMo 网关',
        protocol: 'openai-chat',
        baseURL: 'http://localhost/v1',
        apiKey: 'custom-secret',
        modelId: 'MiMo - V2.5',
        probe: { text: 'supported', tools: 'supported', image: 'supported' },
        checkedAt: '2026-07-16T00:00:00.000Z',
      }],
    }
    const snapshot = createModelSettingsSnapshot(config)
    assert.equal(snapshot.providers.find((item) => item.id === 'mimo')?.hasKey, true)
    assert.equal(snapshot.customConnections[0]?.matchedProfile?.id, 'mimo:mimo-v2.5')
    assert.doesNotMatch(JSON.stringify(snapshot), /secret-key|custom-secret/)
  })

  it('官方设置支持保留、替换、清除 key 和恢复默认端点', () => {
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

  it('删除自定义连接时同步移除失效的默认模型', () => {
    const config: WhycodeConfig = {
      providers: {},
      defaultModel: 'custom:one',
      customConnections: [{
        id: 'one',
        name: '连接',
        protocol: 'openai-chat',
        baseURL: 'http://localhost/v1',
        apiKey: 'key',
        modelId: 'model',
        probe: { text: 'supported', tools: 'supported', image: 'unknown' },
        checkedAt: '2026-07-16T00:00:00.000Z',
      }],
    }
    const next = deleteCustomConnection(config, 'one')
    assert.deepEqual(next.customConnections, [])
    assert.equal(next.defaultModel, undefined)
  })

  it('自定义连接在发起网络检测前拒绝控制字符', async () => {
    const result = await testAndUpdateCustomConnection(null, {
      name: '异常\n连接',
      protocol: 'openai-chat',
      baseURL: 'http://localhost/v1',
      apiKey: 'key',
      modelId: 'model',
    }, new AbortController().signal)
    assert.match(result.error ?? '', /控制字符/)
    assert.equal(result.config, undefined)
  })
})
