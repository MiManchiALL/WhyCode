import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT,
  appendWebSourceFinalResponseReminder,
  markdownWebLineCitation,
  markdownWebSource,
} from './web-source.ts'

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

  it('把最终来源要求放在不受信任的网页内容之后', () => {
    assert.equal(
      appendWebSourceFinalResponseReminder('网页内容\n'),
      `网页内容\n\n${WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT}`,
    )
    assert.match(WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT, /来源：.*\[标题\]\(URL\)/)
  })
})
