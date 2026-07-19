import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WEB_FETCH_MAX_OUTPUT_CHARS } from '@whycode/core'
import { extractWebPage } from './extract.ts'
import {
  createWebPageReader,
  type WebPageReaderOptions,
} from './reader.ts'

const activeSignal = new AbortController().signal

function createTestReader(options: Omit<WebPageReaderOptions, 'extractDocument'>) {
  return createWebPageReader({
    ...options,
    extractDocument: async (document) => {
      if (document.kind !== 'text') throw new Error('测试仅接受文本网页')
      return extractWebPage(document)
    },
  })
}

describe('会话级网页正文读取器', () => {
  it('分页和查找复用同一份稳定正文，不重复联网', async () => {
    let fetches = 0
    const reader = createTestReader({
      fetchDocument: async (url) => {
        fetches++
        return {
          kind: 'text',
          requestedUrl: url,
          finalUrl: 'https://example.com/final',
          contentType: 'text/plain',
          text: [
            'line one',
            'line two',
            'Release Notes',
            'line four',
            'release notes again',
          ].join('\n'),
        }
      },
    })

    const first = await reader.fetchPage({
      url: 'https://example.com/start',
      offset: 1,
      limit: 2,
    }, activeSignal)
    const second = await reader.fetchPage({
      url: 'https://example.com/start',
      offset: 3,
      limit: 2,
    }, activeSignal)
    const found = await reader.findInPage({
      url: 'https://example.com/final',
      pattern: 'release notes',
      context: 1,
      maxResults: 10,
    }, activeSignal)

    assert.deepEqual(first.lines, ['line one', 'line two'])
    assert.deepEqual(second.lines, ['Release Notes', 'line four'])
    assert.deepEqual(found.matches.map((match) => match.lineNumber), [3, 5])
    assert.deepEqual(found.matches[0]?.context.map((line) => line.lineNumber), [2, 3, 4])
    assert.equal(fetches, 1)
  })

  it('未读取或缓存过期时 WebFind 明确要求先调用 WebFetch', async () => {
    let currentTime = 1_000
    const reader = createTestReader({
      now: () => currentTime,
      cacheTtlMs: 100,
      fetchDocument: async (url) => ({
        kind: 'text',
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/plain',
        text: 'cached content',
      }),
    })
    const findRequest = {
      url: 'https://example.com/',
      pattern: 'cached',
      context: 0,
      maxResults: 5,
    }

    await assert.rejects(reader.findInPage(findRequest, activeSignal), /先使用 WebFetch/)
    await reader.fetchPage({ url: findRequest.url, offset: 1, limit: 10 }, activeSignal)
    currentTime += 101
    await assert.rejects(reader.findInPage(findRequest, activeSignal), /先使用 WebFetch/)
  })

  it('每次分页结果受字符预算约束，并保留继续读取的真实行号', async () => {
    const longLine = 'A'.repeat(4_000)
    const reader = createTestReader({
      fetchDocument: async (url) => ({
        kind: 'text',
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/plain',
        text: [longLine, longLine, longLine].join('\n'),
      }),
    })

    const result = await reader.fetchPage({
      url: 'https://example.com/large',
      offset: 1,
      limit: 100,
    }, activeSignal)
    assert.equal(result.lines.length, 2)
    assert.equal(result.lines.reduce((sum, line) => sum + line.length, 0)
      <= WEB_FETCH_MAX_OUTPUT_CHARS, true)
    assert.equal(result.totalLines, 3)
  })

  it('同一 URL 的并行分页只抓取和提取一次', async () => {
    let fetches = 0
    let finishFetch: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { finishFetch = resolve })
    const reader = createTestReader({
      fetchDocument: async (url) => {
        fetches++
        await gate
        return {
          kind: 'text',
          requestedUrl: url,
          finalUrl: url,
          contentType: 'text/plain',
          text: 'one\ntwo\nthree\nfour',
        }
      },
    })
    const first = reader.fetchPage({
      url: 'https://example.com/', offset: 1, limit: 2,
    }, activeSignal)
    const second = reader.fetchPage({
      url: 'https://example.com/', offset: 3, limit: 2,
    }, activeSignal)
    finishFetch?.()

    assert.deepEqual((await first).lines, ['one', 'two'])
    assert.deepEqual((await second).lines, ['three', 'four'])
    assert.equal(fetches, 1)
  })
})
