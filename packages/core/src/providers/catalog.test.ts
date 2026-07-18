import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  getModelProfile,
  matchCustomModelProfile,
  matchModelProfile,
  normalizeModelIdentity,
  parseCustomModelThinkingSuffix,
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
      ['Gemini / 3_1 Pro Preview', 'google:gemini-3.1-pro-preview'],
      ['GEMINI-3.5_FLASH', 'google:gemini-3.5-flash'],
      ['MiMo / V2_5', 'mimo:mimo-v2.5'],
      ['glm 5v_turbo', 'zhipu:glm-5v-turbo'],
      ['GPT / 5_6', 'openai:gpt-5.6-sol'],
      ['GPT / 5_6 Terra', 'openai:gpt-5.6-terra'],
      ['GPT / 5_6 Luna', 'openai:gpt-5.6-luna'],
      ['GPT / 5_5', 'openai:gpt-5.5'],
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
    assert.deepEqual(matchModelProfile('gemini-3.1-pro'), { status: 'none' })
    assert.deepEqual(matchModelProfile('sonnet-4-6'), { status: 'none' })
  })

  it('仅为自定义连接识别受支持的 CLIProxyAPI 思考后缀', () => {
    const cases = [
      ['gpt-5.6-sol(medium)', 'openai:gpt-5.6-sol'],
      ['GPT-5.6-Terra（XHIGH）', 'openai:gpt-5.6-terra'],
      ['gpt-5.5(8192)', 'openai:gpt-5.5'],
      ['gpt-5.6-luna()', 'openai:gpt-5.6-luna'],
      ['gemini-3-flash-agent(high)', 'google:gemini-3.5-flash'],
    ] as const
    for (const [input, expectedProfileId] of cases) {
      const result = matchCustomModelProfile(input)
      assert.equal(result.status, 'matched', input)
      if (result.status === 'matched') {
        assert.equal(result.profile.id, expectedProfileId, input)
      }
    }

    assert.deepEqual(matchModelProfile('gpt-5.6-sol(medium)'), { status: 'none' })
    assert.deepEqual(matchCustomModelProfile('gpt-5.6-sol(turbo)'), { status: 'none' })
    assert.deepEqual(matchCustomModelProfile('gpt-5.6-sol(medium)-fast'), { status: 'none' })
  })

  it('单独解析思考后缀但保留原始模型 ID 的职责边界', () => {
    assert.deepEqual(parseCustomModelThinkingSuffix('gpt-5.6-sol（XHIGH）'), {
      baseModelId: 'gpt-5.6-sol',
      modifier: 'xhigh',
    })
    assert.deepEqual(parseCustomModelThinkingSuffix('gemini-3-flash-agent()'), {
      baseModelId: 'gemini-3-flash-agent',
      modifier: '',
    })
    assert.equal(parseCustomModelThinkingSuffix('gpt-5.6-sol(turbo)'), null)
  })

  it('同一归一化名称指向多个画像时拒绝继承', () => {
    const base = getModelProfile('anthropic:claude-sonnet-4-6')
    const first = { ...base, id: 'test:first', aliases: ['Example Model 7.3'] }
    const second = { ...base, id: 'test:second', aliases: ['Example-Model-7_3'] }
    const result = matchModelProfile('EXAMPLE / MODEL 7．3', [first, second])
    assert.equal(result.status, 'ambiguous')
  })
})
