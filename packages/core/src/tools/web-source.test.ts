import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { markdownWebLineCitation, markdownWebSource } from './web-source.ts'

describe('网页 Markdown 来源', () => {
  it('转义标题并保留可点击 URL 与稳定行范围', () => {
    const url = 'https://example.com/docs?q=whycode'
    assert.equal(
      markdownWebSource('Guide [v2]', url),
      '[Guide \\[v2\\]](<https://example.com/docs?q=whycode>)',
    )
    assert.equal(
      markdownWebLineCitation('Guide', url, 12, 18),
      '[Guide](<https://example.com/docs?q=whycode>)（L12-L18）',
    )
  })
})
