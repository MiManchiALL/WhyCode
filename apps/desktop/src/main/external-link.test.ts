import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeExternalWebUrl } from './external-link.ts'

describe('外部网页链接边界', () => {
  it('只允许不含凭据的 HTTP/HTTPS 地址', () => {
    assert.equal(
      normalizeExternalWebUrl('https://example.com/docs?q=whycode'),
      'https://example.com/docs?q=whycode',
    )
    assert.equal(normalizeExternalWebUrl('file:///C:/secret.txt'), null)
    assert.equal(normalizeExternalWebUrl('javascript:alert(1)'), null)
    assert.equal(normalizeExternalWebUrl('https://user:pass@example.com/'), null)
  })
})
