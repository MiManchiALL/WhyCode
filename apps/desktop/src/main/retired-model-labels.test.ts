import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WhycodeConfig } from './config.ts'
import { retainReferencedRetiredModelLabels } from './retired-model-labels.ts'

describe('退役模型显示名生命周期', () => {
  it('只保留仍被历史会话最后模型选择引用的显示名', () => {
    const config: WhycodeConfig = {
      providers: {},
      retiredModelLabels: {
        'custom:kept': 'Kept Model',
        'custom:deleted': 'Deleted Model',
      },
    }
    const next = retainReferencedRetiredModelLabels(config, new Set(['custom:kept']))
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
    const next = retainReferencedRetiredModelLabels(config, new Set())
    assert.equal(next.retiredModelLabels, undefined)
  })
})
