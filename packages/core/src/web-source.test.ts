import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT,
  appendWebSourceFinalResponseReminder,
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

  it('把最终来源要求放在不受信任的网页内容之后', () => {
    assert.equal(
      appendWebSourceFinalResponseReminder('网页内容\n'),
      `网页内容\n\n${WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT}`,
    )
    assert.match(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT, /最终交付是调研/)
    assert.match(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT, /中间查证不列来源/)
    assert.match(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT, /\[实际来源标题\]\(实际URL "whycode:source"\)/)
    assert.match(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT, /普通的官网、控制台等操作链接不带引用标记/)
    assert.match(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT, /来源无需调用 Present/)
    assert.match(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT, /不要另写末尾来源列表/)
  })

  it('规范化完整 URL 并拒绝凭据和非网页协议', () => {
    assert.equal(normalizeSourceUrl('https://EXAMPLE.com:443/a?q=1#part'), 'https://example.com/a?q=1#part')
    for (const url of ['https://user:secret@example.com', 'https://user@example.com', 'file:///a', 'javascript:alert(1)', 'not-url', undefined]) {
      assert.equal(normalizeSourceUrl(url), null)
    }
  })
})
