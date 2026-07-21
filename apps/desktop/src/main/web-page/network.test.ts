import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WEB_DOCUMENT_MAX_BYTES,
  WEB_PDF_MAX_BYTES,
  createWebDocumentFetcher,
  type WebPageFetchInit,
} from './network.ts'

const publicResolver = async () => ({ endpoints: [{ address: '93.184.216.34' }] })
const activeSignal = new AbortController().signal

describe('网页抓取网络边界', () => {
  it('使用无凭据、无缓存、手动重定向的 GET 请求', async () => {
    let requestedUrl = ''
    let requestedInit: WebPageFetchInit | undefined
    const fetchDocument = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async (url, init) => {
        requestedUrl = url
        requestedInit = init
        return new Response('<html><body>Hello</body></html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      },
    })

    assert.deepEqual(await fetchDocument('https://example.com/page#part', activeSignal), {
      kind: 'text',
      requestedUrl: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      contentType: 'text/html',
      text: '<html><body>Hello</body></html>',
    })
    assert.equal(requestedUrl, 'https://example.com/page')
    assert.equal(requestedInit?.method, 'GET')
    assert.equal(requestedInit?.credentials, 'omit')
    assert.equal(requestedInit?.cache, 'no-store')
    assert.equal(requestedInit?.redirect, 'manual')
    assert.equal(requestedInit?.referrerPolicy, 'no-referrer')
    assert.equal(requestedInit?.bypassCustomProtocolHandlers, true)
  })

  it('逐跳校验公开重定向，并拒绝重定向到本机地址', async () => {
    const publicCalls: string[] = []
    const publicRedirect = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async (url) => {
        publicCalls.push(url)
        return publicCalls.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://docs.example.com/final' } })
          : new Response('Done', { headers: { 'content-type': 'text/plain' } })
      },
    })
    const redirected = await publicRedirect('https://example.com/start', activeSignal)
    assert.equal(redirected.finalUrl, 'https://docs.example.com/final')
    assert.deepEqual(publicCalls, [
      'https://example.com/start',
      'https://docs.example.com/final',
    ])

    let calls = 0
    const privateRedirect = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => {
        calls++
        return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/admin' } })
      },
    })
    await assert.rejects(
      privateRedirect('https://example.com/start', activeSignal),
      /不能访问本机、内网或保留地址/,
    )
    assert.equal(calls, 1, '私网目标必须在第二次请求前被拒绝')

    const insecureRedirect = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: 'http://example.com/insecure' },
      }),
    })
    await assert.rejects(
      insecureRedirect('https://example.com/start', activeSignal),
      /HTTPS.*不安全的 HTTP/,
    )
  })

  it('拒绝二进制类型、声明或流式超限的响应', async () => {
    const binary = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response('binary', {
        headers: { 'content-type': 'application/octet-stream' },
      }),
    })
    const declaredOversized = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response('small', {
        headers: {
          'content-type': 'text/plain',
          'content-length': String(WEB_DOCUMENT_MAX_BYTES + 1),
        },
      }),
    })
    const streamedOversized = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(new Uint8Array(WEB_DOCUMENT_MAX_BYTES + 1), {
        headers: { 'content-type': 'text/plain' },
      }),
    })

    await assert.rejects(binary('https://example.com/file', activeSignal), /暂不支持/)
    await assert.rejects(declaredOversized('https://example.com/file', activeSignal), /超过安全大小/)
    await assert.rejects(streamedOversized('https://example.com/file', activeSignal), /超过安全大小/)
  })

  it('按响应 charset 解码文本，HTTP 错误不回传响应正文', async () => {
    const encoded = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(Uint8Array.from([0x63, 0x61, 0x66, 0xE9]), {
        headers: { 'content-type': 'text/plain; charset=windows-1252' },
      }),
    })
    const encodedDocument = await encoded('https://example.com/text', activeSignal)
    assert.equal(encodedDocument.kind, 'text')
    assert.equal(encodedDocument.kind === 'text' ? encodedDocument.text : null, 'café')

    const sniffedHtml = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(new TextEncoder().encode(
        '<!-- header --><html><body>content</body></html>',
      )),
    })
    assert.equal(
      (await sniffedHtml('https://example.com/no-content-type', activeSignal)).contentType,
      'text/html',
    )

    const failure = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response('secret upstream details', { status: 403 }),
    })
    await assert.rejects(failure('https://example.com/private', activeSignal), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.equal(message, '目标网页需要登录或拒绝访问')
      assert.doesNotMatch(message, /secret upstream details/)
      return true
    })
  })

  it('DNS 解析也受统一超时控制', async () => {
    const fetchDocument = createWebDocumentFetcher({
      timeoutMs: 5,
      resolveHost: async () => new Promise(() => {}),
      fetchImpl: async () => new Response('unreachable'),
    })
    await assert.rejects(
      fetchDocument('https://example.com/', activeSignal),
      /网页读取请求超时/,
    )
  })

  it('识别并按 PDF 的既有 50 MB 边界返回原始字节', async () => {
    const pdfBytes = new TextEncoder().encode('%PDF-1.7\nremote document')
    const fetchDocument = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response(pdfBytes, {
        headers: { 'content-type': 'application/pdf' },
      }),
    })

    const document = await fetchDocument('https://example.com/report.pdf', activeSignal)
    assert.equal(document.kind, 'pdf')
    assert.equal(document.contentType, 'application/pdf')
    assert.deepEqual(document.kind === 'pdf' ? document.bytes : null, pdfBytes)

    const oversizedPdf = createWebDocumentFetcher({
      resolveHost: publicResolver,
      fetchImpl: async () => new Response('%PDF-1.7', {
        headers: {
          'content-type': 'application/pdf',
          'content-length': String(WEB_PDF_MAX_BYTES + 1),
        },
      }),
    })
    await assert.rejects(
      oversizedPdf('https://example.com/oversized.pdf', activeSignal),
      /超过安全大小限制/,
    )
  })
})
