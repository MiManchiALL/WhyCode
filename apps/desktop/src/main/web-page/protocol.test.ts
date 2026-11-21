import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WEB_PAGE_MAX_LINE_CHARS } from '@whycode/core'
import { isWebPageWorkerResponse, type WebPageWorkerRequest } from './protocol.ts'

const request: WebPageWorkerRequest = {
  id: 'request-1',
  document: {
    kind: 'text',
    requestedUrl: 'https://example.com/start',
    finalUrl: 'https://example.com/final',
    contentType: 'text/html',
    text: '<main>content</main>',
  },
}

describe('网页提取子进程协议', () => {
  it('只接受匹配请求来源且严格有界的正文结果', () => {
    assert.equal(isWebPageWorkerResponse({
      id: request.id,
      ok: true,
      result: {
        requestedUrl: request.document.requestedUrl,
        finalUrl: request.document.finalUrl,
        title: 'Example',
        contentType: request.document.contentType,
        lines: ['# Example', 'content'],
        sourceTruncated: false,
      },
    }, request), true)

    assert.equal(isWebPageWorkerResponse({
      id: request.id,
      ok: true,
      result: {
        requestedUrl: request.document.requestedUrl,
        finalUrl: 'https://attacker.example/',
        contentType: request.document.contentType,
        lines: ['content'],
        sourceTruncated: false,
      },
    }, request), false)

    assert.equal(isWebPageWorkerResponse({
      id: request.id,
      ok: true,
      result: {
        requestedUrl: request.document.requestedUrl,
        finalUrl: request.document.finalUrl,
        contentType: request.document.contentType,
        lines: ['A'.repeat(WEB_PAGE_MAX_LINE_CHARS + 1)],
        sourceTruncated: false,
      },
    }, request), false)
  })

  it('替代地址只接受已解析且属于当前最终页面的 URL', () => {
    const result = { requestedUrl: request.document.requestedUrl, finalUrl: request.document.finalUrl,
      contentType: 'text/html', lines: ['content'], sourceTruncated: false }
    const accepts = (markdownUrl: unknown) => isWebPageWorkerResponse({
      id: request.id, ok: true, result: { ...result, markdownUrl },
    }, request)
    assert.equal(accepts('https://example.com/final.md'), true)
    for (const url of [undefined, 42, 'final.md', 'https://user:pw@example.com/final.md', 'https://internal.example/final.md', 'https://example.com/llms.txt']) {
      assert.equal(accepts(url), false)
    }
  })
})
