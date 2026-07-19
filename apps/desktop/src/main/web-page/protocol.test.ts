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
})
