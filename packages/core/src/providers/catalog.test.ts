import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getModelProfile,
  matchModelProfile,
  normalizeModelIdentity,
} from './catalog.ts'

describe('模型画像严格匹配', () => {
  it('忽略大小写、宽窄字符和常见分隔符', () => {
    assert.equal(normalizeModelIdentity(' MiMo - V2．5 '), 'mimov25')
    assert.equal(normalizeModelIdentity('MIMO_V2/5'), 'mimov25')
  })

  it('对所有维护型号统一处理大小写、宽窄和分隔符差异', () => {
    const cases = [
      ['CLAUDE＿SONNET / 4．6', 'anthropic:claude-sonnet-4-6'],
      ['deepseek v4_flash', 'deepseek:deepseek-v4-flash'],
      ['MiMo / V2_5', 'mimo:mimo-v2.5'],
      ['glm 5v_turbo', 'zhipu:glm-5v-turbo'],
      ['GPT / 5_2', 'openai:gpt-5.2'],
    ] as const

    for (const [input, expectedProfileId] of cases) {
      const result = matchModelProfile(input)
      assert.equal(result.status, 'matched', input)
      if (result.status === 'matched') {
        assert.equal(result.profile.id, expectedProfileId, input)
      }
    }
  })

  it('不使用子串或相近版本猜测未知型号', () => {
    assert.deepEqual(matchModelProfile('mimo-v2.6'), { status: 'none' })
    assert.deepEqual(matchModelProfile('sonnet-4-6'), { status: 'none' })
  })

  it('同一归一化名称指向多个画像时拒绝继承', () => {
    const base = getModelProfile('anthropic:claude-sonnet-4-6')
    const first = { ...base, id: 'test:first', aliases: ['Example Model 7.3'] }
    const second = { ...base, id: 'test:second', aliases: ['Example-Model-7_3'] }
    const result = matchModelProfile('EXAMPLE / MODEL 7．3', [first, second])
    assert.equal(result.status, 'ambiguous')
  })
})
