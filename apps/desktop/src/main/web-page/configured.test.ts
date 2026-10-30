import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createWebFetchTool, WebPageError } from '@whycode/core'
import type { WhycodeConfig } from '../config.ts'
import { createConfiguredWebDocumentFetcher } from './configured.ts'
import { createWebPageReader } from './reader.ts'
import { extractWebPage } from './extract.ts'
import { WEB_PAGE_MAX_CONTENT_CHARS } from './content.ts'
import type { WebDocument } from './network.ts'

const signal = new AbortController().signal
const resolveHost = async () => ({ endpoints: [{ address: '93.184.216.34' }] })
const configured: WhycodeConfig = {
  providers: { deepseek: { apiKey: 'model-key', baseURL: 'https://model.example.com' } },
  webSearch: { activeProvider: 'perplexity', deepseek: { apiKey: 'web-key' }, perplexity: { apiKey: 'search-key' } },
  webFetch: { provider: 'deepseek' },
}
const unusedBuiltin = async (): Promise<WebDocument> => assert.fail('不应调用内置抓取')

describe('配置化网页抓取', () => {
  it('默认为内置，未缓存请求使用当前配置且搜索选择相互独立', async () => {
    let config: WhycodeConfig | null = null
    const calls: string[] = []
    const fetchDocument = createConfiguredWebDocumentFetcher({
      getConfig: () => config,
      resolveHost,
      fetchBuiltin: async (url) => {
        calls.push('builtin')
        return { kind: 'text', requestedUrl: url, finalUrl: url, contentType: 'text/plain', text: 'built in' }
      },
      fetchImpl: async (url, init) => {
        calls.push(url)
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer web-key')
        assert.equal(init.redirect, 'error')
        assert.deepEqual(JSON.parse(String(init.body)), { url: 'https://example.com/page' })
        return Response.json({ title: ' Page  title ', content: '# Heading\n\nEvidence' })
      },
    })
    assert.equal((await fetchDocument('https://example.com/page', signal)).kind, 'text')
    config = configured
    const document = await fetchDocument('https://example.com/page#heading', signal)
    assert.deepEqual(document, {
      kind: 'text', requestedUrl: 'https://example.com/page', finalUrl: 'https://example.com/page',
      contentType: 'text/markdown', title: 'Page title', text: '# Heading\n\nEvidence',
    })
    assert.deepEqual(calls, ['builtin', 'https://api.deepseek.com/v1/tools/fetch'])
  })

  it('DeepSeek 正文复用稳定分页、标题、WebFind 与有界会话缓存', async () => {
    let calls = 0
    const reader = createWebPageReader({
      fetchDocument: createConfiguredWebDocumentFetcher({
        getConfig: () => configured, resolveHost, fetchBuiltin: unusedBuiltin,
        fetchImpl: async () => {
          calls++
          return Response.json({ title: '文档', content: '# Document\n\nfirst\nneedle\nlast\n' + 'x'.repeat(300_000) })
        },
      }),
      extractDocument: async (document) => extractWebPage(document),
      importPdfDocument: async () => assert.fail('Markdown 不应导入 PDF'),
    })
    const first = await reader.fetchPage({ url: 'https://example.com/', limit: 3 }, signal)
    assert.equal(first.kind, 'page')
    if (first.kind !== 'page') assert.fail()
    assert.equal(first.title, '文档')
    assert.deepEqual(first.lines, ['# Document', '', 'first'])
    assert.equal(first.sourceTruncated, true)
    const next = await reader.fetchPage({ url: 'https://example.com/', offset: 4, limit: 2 }, signal)
    assert.equal(next.kind, 'page')
    if (next.kind !== 'page') assert.fail()
    assert.deepEqual(next.lines, ['needle', 'last'])
    const found = await reader.findInPage({ url: 'https://example.com/', pattern: 'needle', context: 1, maxResults: 10 }, signal)
    assert.equal(found.matches[0]?.lineNumber, 4)
    assert.ok(first.totalLines < WEB_PAGE_MAX_CONTENT_CHARS)
    assert.equal(calls, 1)
  })

  it('已知 PDF 链接继续使用内置下载而不调用 Markdown 服务', async () => {
    let nativeUrl = ''
    const fetchDocument = createConfiguredWebDocumentFetcher({
      getConfig: () => configured, resolveHost,
      fetchBuiltin: async (url) => {
        nativeUrl = url
        return { kind: 'pdf', requestedUrl: url, finalUrl: url, contentType: 'application/pdf', bytes: new Uint8Array([1, 2]) }
      },
      fetchImpl: async () => assert.fail('PDF 不调用 DeepSeek'),
    })
    assert.equal((await fetchDocument('https://example.com/REPORT.PDF?download=1', signal)).kind, 'pdf')
    assert.equal(nativeUrl, 'https://example.com/REPORT.PDF?download=1')
  })

  it('拒绝非公开地址和内嵌凭据，绝不把这些 URL 发给 DeepSeek', async () => {
    let calls = 0
    const fetchDocument = createConfiguredWebDocumentFetcher({
      getConfig: () => configured, fetchBuiltin: unusedBuiltin,
      resolveHost: async () => ({ endpoints: [{ address: '10.0.0.1' }] }),
      fetchImpl: async () => { calls++; return Response.json({ title: '', content: 'body' }) },
    })
    for (const url of ['file:///secret', 'https://user:pass@example.com', 'http://localhost', 'http://127.0.0.1', 'http://private.example.com']) {
      await assert.rejects(fetchDocument(url, signal), WebPageError)
    }
    assert.equal(calls, 0)
  })

  it('缺少网页密钥不借用模型凭据；HTTP 错误不回退、不泄漏正文', async () => {
    const config = { ...configured, webSearch: undefined }
    let calls = 0
    const fetchDocument = createConfiguredWebDocumentFetcher({
      getConfig: () => config, resolveHost, fetchBuiltin: unusedBuiltin,
      fetchImpl: async () => { calls++; return new Response('web-key hostile', { status: 404 }) },
    })
    await assert.rejects(fetchDocument('https://example.com/', signal), /尚未配置/)
    assert.equal(calls, 0)
    const missingKeyTool = createWebFetchTool({
      fetchPage: async () => { await fetchDocument('https://example.com/', signal); assert.fail() },
    })
    const missing = await missingKeyTool.execute({ url: 'https://example.com/' }, {
      projectDir: '.', additionalDirs: [], abortSignal: signal,
    })
    assert.equal(missing.isError, true)
    assert.match(missing.data, /尚未配置/)
    const failing = createConfiguredWebDocumentFetcher({
      getConfig: () => configured, resolveHost, fetchBuiltin: unusedBuiltin,
      fetchImpl: async () => { calls++; return new Response('web-key hostile', { status: 404 }) },
    })
    await assert.rejects(failing('https://example.com/', signal), (error: unknown) => {
      assert.ok(error instanceof WebPageError)
      assert.match(error.message, /内置抓取/)
      assert.doesNotMatch(error.message, /web-key|hostile/)
      return true
    })
    assert.equal(calls, 1)
  })

  it('空正文、畸形和超大响应均为失败', async () => {
    for (const response of [
      Response.json({ title: '', content: '  ' }),
      Response.json({ content: 'no title field' }),
      new Response('{}', { headers: { 'content-length': '5000001' } }),
    ]) {
      const fetchDocument = createConfiguredWebDocumentFetcher({
        getConfig: () => configured, resolveHost, fetchBuiltin: unusedBuiltin,
        fetchImpl: async () => response,
      })
      await assert.rejects(fetchDocument('https://example.com/', signal), WebPageError)
    }
  })

  it('停止时取消 DNS 等待，不继续调用 API', async () => {
    let startResolving!: () => void
    const resolving = new Promise<void>((resolve) => { startResolving = resolve })
    let finishDns!: (result: { endpoints: { address: string }[] }) => void
    const dns = new Promise<{ endpoints: { address: string }[] }>((resolve) => { finishDns = resolve })
    const controller = new AbortController()
    const fetchDocument = createConfiguredWebDocumentFetcher({
      getConfig: () => configured, fetchBuiltin: unusedBuiltin,
      resolveHost: () => { startResolving(); return dns },
      fetchImpl: async () => assert.fail('取消后不应发请求'),
    })
    const pending = fetchDocument('https://example.com/', controller.signal)
    const check = assert.rejects(pending, /已取消/)
    await resolving
    controller.abort()
    await check
    finishDns({ endpoints: [{ address: '93.184.216.34' }] })
  })
})
