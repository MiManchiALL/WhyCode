import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { contextUsagePresentation, formatContextTokens } from './context-usage.ts'

describe('上下文圆环投影', () => {
  it('限制圆环比例并按分项切分已占用区间', () => {
    const presentation = contextUsagePresentation({
      usedTokens: 29_400,
      contextWindow: 100_000,
      breakdown: {
        systemPromptTokens: 2_000,
        toolTokens: 8_000,
        messageTokens: 20_000,
      },
    })

    assert.equal(presentation?.percent, 29)
    assert.equal(
      Math.round(presentation?.segments.reduce((sum, segment) => sum + segment.width, 0) ?? 0),
      29,
    )
    assert.deepEqual(presentation?.segments.map((segment) => segment.key), [
      'system',
      'tools',
      'messages',
    ])
  })

  it('无效窗口不展示，超窗比例封顶且 token 使用紧凑格式', () => {
    assert.equal(contextUsagePresentation({
      usedTokens: 1,
      contextWindow: 0,
      breakdown: { systemPromptTokens: 0, toolTokens: 0, messageTokens: 1 },
    }), null)
    assert.equal(contextUsagePresentation({
      usedTokens: 150_000,
      contextWindow: 100_000,
      breakdown: { systemPromptTokens: 0, toolTokens: 0, messageTokens: 150_000 },
    })?.percent, 100)
    assert.equal(formatContextTokens(75_300), '75.3K')
    assert.equal(formatContextTokens(262_000), '262K')
    assert.equal(formatContextTokens(1_000_000), '1M')
  })
})
