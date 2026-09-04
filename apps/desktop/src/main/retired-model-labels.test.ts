import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cliProxyModelId, type WhycodeConfig } from './config.ts'
import { syncReferencedRetiredModelLabels } from './retired-model-labels.ts'

describe('退役模型显示名生命周期', () => {
  it('只保留仍被历史会话最后模型选择引用的显示名', () => {
    const config: WhycodeConfig = {
      providers: {},
      retiredModelLabels: {
        'custom:kept': 'Kept Model',
        'custom:deleted': 'Deleted Model',
      },
    }
    const next = syncReferencedRetiredModelLabels(config, new Set(['custom:kept']))
    assert.deepEqual(next.retiredModelLabels, { 'custom:kept': 'Kept Model' })
    assert.deepEqual(config.retiredModelLabels, {
      'custom:kept': 'Kept Model',
      'custom:deleted': 'Deleted Model',
    })
  })

  it('没有任何历史引用时完整移除退役显示名配置域', () => {
    const config: WhycodeConfig = {
      providers: {},
      retiredModelLabels: { 'openai:gpt-5.2': 'GPT-5.2' },
    }
    const next = syncReferencedRetiredModelLabels(config, new Set())
    assert.equal(next.retiredModelLabels, undefined)
  })

  it('按实际引用补齐退役 Gemini 的原名，切换或删除后不留下孤儿名称', () => {
    const officialId = 'google:gemini-3.7-flash'
    const proxyId = cliProxyModelId(officialId)
    const config: WhycodeConfig = { providers: {} }
    assert.equal(syncReferencedRetiredModelLabels(config, new Set()), config)
    const referenced = syncReferencedRetiredModelLabels(config, new Set([officialId, proxyId]))
    assert.deepEqual(referenced.retiredModelLabels, {
      [officialId]: 'Gemini 3.7 Flash',
      [proxyId]: 'Gemini 3.7 Flash（CLIProxyAPI）',
    })
    assert.equal(
      syncReferencedRetiredModelLabels(referenced, new Set([officialId, proxyId])),
      referenced,
    )
    const remaining = syncReferencedRetiredModelLabels(referenced, new Set([proxyId]))
    assert.deepEqual(remaining.retiredModelLabels, { [proxyId]: 'Gemini 3.7 Flash（CLIProxyAPI）' })
    assert.equal(syncReferencedRetiredModelLabels(remaining, new Set()).retiredModelLabels, undefined)
  })
})
