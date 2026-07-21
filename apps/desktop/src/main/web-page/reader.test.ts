import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WEB_FETCH_MAX_OUTPUT_CHARS,
  type WebFetchPageResponse,
  type WebFetchResponse,
} from '@whycode/core'
import { extractWebPage } from './extract.ts'
import {
  createWebPageReader,
  type WebPageReaderOptions,
} from './reader.ts'

const activeSignal = new AbortController().signal

function createTestReader(
  options: Omit<WebPageReaderOptions, 'extractDocument' | 'importPdfDocument'>,
) {
  return createWebPageReader({
    ...options,
    extractDocument: async (document) => extractWebPage(document),
    importPdfDocument: async () => { throw new Error('测试未配置 PDF 导入') },
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

    assert.deepEqual(page(first).lines, ['line one', 'line two'])
    assert.deepEqual(page(second).lines, ['Release Notes', 'line four'])
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
    const resultPage = page(result)
    assert.equal(resultPage.lines.length, 2)
    assert.equal(resultPage.lines.reduce((sum, line) => sum + line.length, 0)
      <= WEB_FETCH_MAX_OUTPUT_CHARS, true)
    assert.equal(resultPage.totalLines, 3)
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

    assert.deepEqual(page(await first).lines, ['one', 'two'])
    assert.deepEqual(page(await second).lines, ['three', 'four'])
    assert.equal(fetches, 1)
  })

  it('远程 PDF 只导入会话附件，不进入正文缓存和行分页', async () => {
    const attachment = {
      id: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222',
      name: 'remote.pdf',
      storageName: '11111111-1111-4111-8111-111111111111.pdf',
      mediaType: 'application/pdf' as const,
      origin: 'web' as const,
      sha256: 'a'.repeat(64),
      byteLength: 20,
      pageCount: 3,
    }
    let imports = 0
    const reader = createWebPageReader({
      fetchDocument: async (url) => ({
        kind: 'pdf',
        requestedUrl: url,
        finalUrl: 'https://cdn.example.com/remote.pdf',
        contentType: 'application/pdf',
        bytes: new TextEncoder().encode('%PDF-1.4'),
      }),
      extractDocument: async () => assert.fail('PDF 不应进入网页正文提取'),
      importPdfDocument: async () => {
        imports++
        return attachment
      },
    })

    const result = await reader.fetchPage({ url: 'https://example.com/download' }, activeSignal)

    assert.equal(result.kind, 'pdf')
    assert.equal(result.kind === 'pdf' ? result.attachment.id : null, attachment.id)
    assert.equal(imports, 1)
    await assert.rejects(reader.findInPage({
      url: 'https://example.com/download',
      pattern: 'anything',
      context: 0,
      maxResults: 1,
    }, activeSignal), /ReadPdf/)
  })
})

function page(result: WebFetchResponse): WebFetchPageResponse {
  assert.equal(result.kind, 'page')
  if (result.kind !== 'page') throw new Error('期望文本网页结果')
  return result
}
