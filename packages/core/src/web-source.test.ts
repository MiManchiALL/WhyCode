import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  markdownWebLineCitation,
  markdownWebSource,
  normalizeSourceUrl,
} from './web-source.ts'

describe('网页 Markdown 来源', () => {
  it('转义标题并保留可点击 URL 与稳定行范围', () => {
    const url = 'https://example.com/docs?q=whycode'
    assert.equal(
      markdownWebSource('Guide [v2]', url),
      '[Guide \\[v2\\]](<https://example.com/docs?q=whycode> "whycode:source")',
    )
    assert.equal(
      markdownWebLineCitation('Guide', url, 12, 18),
      '[Guide](<https://example.com/docs?q=whycode> "whycode:source")（L12-L18）',
    )
  })

  it('规范化完整 URL 并拒绝凭据和非网页协议', () => {
    assert.equal(normalizeSourceUrl('https://EXAMPLE.com:443/a?q=1#part'), 'https://example.com/a?q=1#part')
    for (const url of ['https://user:secret@example.com', 'https://user@example.com', 'file:///a', 'javascript:alert(1)', 'not-url', undefined]) {
      assert.equal(normalizeSourceUrl(url), null)
    }
  })
})
