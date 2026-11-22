import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WEB_FETCH_MAX_OUTPUT_CHARS,
  createWebFetchTool,
  type WebFetchPageResponse,
  type WebFetchResponse,
} from '@whycode/core'
import { extractWebPage } from './extract.ts'
import { createWebDocumentFetcher, fetchLinkedMarkdown, type WebDocumentFetcherOptions } from './network.ts'
import {
  createWebPageReader,
  type WebPageReaderOptions,
} from './reader.ts'

const activeSignal = new AbortController().signal

function createTestReader(
  options: Pick<WebPageReaderOptions, 'fetchDocument'> & Partial<WebPageReaderOptions>,
) {
  return createWebPageReader({
    fetchLinkedMarkdown: async () => assert.fail('未请求 Markdown 替代页'),
    extractDocument: async (document) => extractWebPage(document),
    importPdfDocument: async () => assert.fail('测试未配置 PDF 导入'),
    ...options,
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
      url: 'https://example.com/final',
      offset: 3,
      limit: 2,
    }, activeSignal)
    const found = await reader.findInPage({
      url: 'https://example.com/final',
      patterns: ['release notes'],
      offset: 1,
      maxResults: 10,
    }, activeSignal)

    assert.deepEqual(page(first).lines, ['line one', 'line two'])
    assert.deepEqual(page(second).lines, ['Release Notes', 'line four'])
    assert.deepEqual(found.matches.map((match) => match.lineNumber), [3, 5])
    assert.equal(found.hasMore, false)
    assert.equal(page(second).requestedUrl, 'https://example.com/final')
    const tool = createWebFetchTool(reader)
    const continued = await tool.execute({ url: found.finalUrl, offset: 5 }, {
      projectDir: '.', additionalDirs: [], abortSignal: activeSignal,
    })
    assert.equal(continued.isError, false)
    assert.match(continued.data, /5\trelease notes again/)
    assert.equal(fetches, 1)
  })

  it('未读取或缓存过期时提示 limit=1，查找不会联网', async () => {
    let currentTime = 1_000
    let fetches = 0
    const reader = createTestReader({
      now: () => currentTime,
      cacheTtlMs: 100,
      fetchDocument: async (url) => {
        fetches++
        return { kind: 'text', requestedUrl: url, finalUrl: url, contentType: 'text/plain', text: 'cached content' }
      },
    })
    const findRequest = {
      url: 'https://example.com/',
      patterns: ['cached'],
      offset: 1,
      maxResults: 5,
    }

    await assert.rejects(reader.findInPage(findRequest, activeSignal), /limit=1/)
    await reader.fetchPage({ url: findRequest.url, offset: 1, limit: 10 }, activeSignal)
    currentTime += 101
    await assert.rejects(reader.findInPage(findRequest, activeSignal), /limit=1/)
    assert.equal(fetches, 1)
  })

  it('所有关键词共享名额，优先覆盖稀有词，同一行只显示一次', async () => {
    const url = 'https://example.com/guide'
    const reader = createTestReader({
      fetchDocument: async () => ({
        kind: 'text', requestedUrl: url, finalUrl: url, contentType: 'text/plain',
        text: 'common one\ncommon two\ncommon three\nrare  word and common\nlast',
      }),
    })
    await reader.fetchPage({ url, limit: 1 }, activeSignal)
    const find = (maxResults: number) => reader.findInPage({ url, patterns: ['rare word', 'common'], offset: 1, maxResults }, activeSignal)
    const shared = await find(3)
    assert.deepEqual(shared.matches.map((row) => row.lineNumber), [1, 2, 4])
    assert.equal(shared.hasMore, true)
    assert.deepEqual((await find(1)).matches.map((row) => row.lineNumber), [4])
    const all = await find(4)
    assert.deepEqual(all.matches.map((row) => row.lineNumber), [1, 2, 3, 4])
    assert.equal(all.hasMore, false)
    assert.deepEqual((await reader.findInPage({ url, patterns: ['missing'], offset: 1, maxResults: 20 }, activeSignal)).matches, [])
  })

  it('跟随查找结果的 offset 取全 47 个匹配，换页大小及提前返回页尾关键词均不遗漏或重复', async () => {
    const url = 'https://example.com/list'
    const expected = Array.from({ length: 47 }, (_, i) => (i + 1) * 2)
    const text = expected.map((line) => 'section\n' + (line === 94 ? 'item rare' : 'item')).join('\n')
    let fetches = 0
    const reader = createTestReader({
      fetchDocument: async () => {
        fetches++
        return { kind: 'text', requestedUrl: url, finalUrl: url, contentType: 'text/plain', text }
      },
    })
    const tool = createWebFetchTool(reader)
    const ctx = { projectDir: '.', additionalDirs: [], abortSignal: activeSignal }
    assert.equal((await tool.execute({ url, limit: 1 }, ctx)).isError, false)
    const seen: number[] = []
    let offset = 1
    for (const max_results of [20, 7, 20]) {
      const input = { url, pattern: ['item', 'rare'], offset, max_results }
      const result = await tool.execute(tool.inputSchema.parse(input), ctx)
      assert.equal(result.isError, false)
      const rows = [...result.data.matchAll(/^ *(\d+)\t/gmu)].map((hit) => Number(hit[1]))
      assert.equal(rows.length, max_results)
      assert.deepEqual(rows, rows.toSorted((a, b) => a - b))
      if (offset === 1) assert.ok(rows.includes(94))
      if (offset === 21) assert.deepEqual(await tool.execute(input, ctx), result)
      seen.push(...rows)
      const hint = /offset=(\d+)/u.exec(result.data)
      if (seen.length < expected.length) {
        assert.ok(hint)
        offset = Number(hint[1])
        assert.equal(offset, seen.length + 1)
      } else {
        assert.equal(hint, null)
      }
    }
    assert.deepEqual(seen.toSorted((a, b) => a - b), expected)
    const beyond = await tool.execute({ url, pattern: 'item', offset: 48 }, ctx)
    assert.equal(beyond.isError, false)
    assert.match(beyond.data, /没有更多结果/)
    assert.doesNotMatch(beyond.data, /offset=|未找到匹配文本/)
    assert.match((await tool.execute({ url, offset: 94, limit: 1 }, ctx)).data, /94\titem rare/)
    assert.equal(fetches, 1)
  })

  it('同页显式 Markdown 优先，原地址、跳转页和最终证据地址可复用同一缓存', async () => {
    const calls: string[] = []
    const origin = 'https://example.com'
    const network: WebDocumentFetcherOptions = {
      resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }] }),
      fetchImpl: async (url, init) => {
        const path = new URL(url).pathname
        calls.push(path)
        assert.equal(init.credentials, 'omit')
        assert.match(new Headers(init.headers).get('accept') ?? '', /^text\/markdown/)
        if (path === '/start') return Response.redirect(origin + '/guide')
        if (path === '/guide') return new Response(
          '<html><head><title>指南</title><link rel="alternate" type="text/markdown" href="guide.md"></head><body><main>HTML 正文</main></body></html>',
          { headers: { 'content-type': 'text/html' } },
        )
        if (path === '/guide.md') return Response.redirect(origin + '/guide/index.md')
        assert.equal(path, '/guide/index.md')
        return new Response('# 指南\nrequest_timeout', { headers: { 'content-type': 'text/plain' } })
      },
    }
    const reader = createTestReader({
      fetchDocument: createWebDocumentFetcher(network),
      fetchLinkedMarkdown: (url, pageUrl, signal) => fetchLinkedMarkdown(url, pageUrl, network, signal),
    })
    const tool = createWebFetchTool(reader)
    const ctx = { projectDir: '.', additionalDirs: [], abortSignal: activeSignal }
    const first = await tool.execute({ url: origin + '/start', limit: 1 }, ctx)
    assert.equal(first.isError, false)
    assert.match(first.data, /\[指南\].*\/guide\/index\.md>.*L1-L1/)
    for (const path of ['/start', '/guide', '/guide.md', '/guide/index.md']) {
      const url = origin + path
      const find = await tool.execute({ url, pattern: ['missing', 'REQUEST_TIMEOUT'] }, ctx)
      assert.equal(find.isError, false)
      assert.match(find.data, /2\trequest_timeout/)
      assert.match((await tool.execute({ url, offset: 2 }, ctx)).data, /2\trequest_timeout/)
    }
    assert.deepEqual(calls, ['/start', '/guide', '/guide.md', '/guide/index.md'])
  })

  it('每次分页结果受字符预算约束，并保留继续读取的真实行号', async () => {
    const longLine = 'A'.repeat(4_000)
    const reader = createTestReader({
      fetchDocument: async (url) => ({
        kind: 'text',
        requestedUrl: url,
        finalUrl: url,
        contentType: 'text/plain',
        text: [longLine, longLine, longLine, 'A short tail'].join('\n'),
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
    assert.equal(resultPage.totalLines, 4)
    const tool = createWebFetchTool(reader)
    const ctx = { projectDir: '.', additionalDirs: [], abortSignal: activeSignal }
    const input = { url: resultPage.finalUrl, pattern: 'a', max_results: 20 }
    const first = await tool.execute(input, ctx)
    assert.match(first.data, /offset=3/)
    assert.doesNotMatch(first.data, /A short tail/)
    const next = await tool.execute({ ...input, offset: 3 }, ctx)
    assert.equal(next.isError, false)
    assert.match(next.data, /3\tA+\n +4\tA short tail$/)
  })

  it('替代页失效后继续使用已提取的 HTML，后续分页和查找不重试', async () => {
    const url = 'https://example.com/guide'
    const calls: string[] = []
    const network: WebDocumentFetcherOptions = {
      resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }] }),
      fetchImpl: async (target) => {
        calls.push(target)
        if (target.endsWith('.md')) return new Response('<html>Login</html>', { headers: { 'content-type': 'text/markdown' } })
        return new Response('<html><head><link rel="alternate" type="text/markdown" href="guide.md"></head><body><main><h1>guide_title</h1><p>request_timeout</p></main></body></html>',
          { headers: { 'content-type': 'text/html' } })
      },
    }
    const reader = createTestReader({
      fetchDocument: createWebDocumentFetcher(network),
      fetchLinkedMarkdown: (target, pageUrl, signal) => fetchLinkedMarkdown(target, pageUrl, network, signal),
    })
    const first = page(await reader.fetchPage({ url, limit: 1 }, activeSignal))
    assert.equal(first.finalUrl, url)
    assert.match(first.lines[0]!, /guide_title/)
    const find = await reader.findInPage({ url, patterns: ['request_timeout'], offset: 1, maxResults: 1 }, activeSignal)
    assert.equal(find.matches[0]?.text, 'request_timeout')
    assert.equal(page(await reader.fetchPage({ url, offset: find.matches[0]!.lineNumber }, activeSignal)).lines[0], 'request_timeout')
    await assert.rejects(reader.findInPage({ url: url + '.md', patterns: ['login'], offset: 1, maxResults: 1 }, activeSignal), /缓存/)
    assert.deepEqual(calls, [url, url + '.md'])
  })

  it('替代链接或后续跳转改变文章身份时，缓存和引用均保留原文', async () => {
    const url = 'https://example.com/article?id=1'
    const linked = 'https://example.com/article.md?id=1'
    const other = 'https://example.com/other.md'
    for (const href of [linked + '&id=2', linked]) {
      const calls: string[] = []
      const network: WebDocumentFetcherOptions = {
        resolveHost: async () => ({ endpoints: [{ address: '93.184.216.34' }] }),
        fetchImpl: async (target) => {
          calls.push(target)
          if (target === url) return new Response(
            `<html><head><link rel="alternate" type="text/markdown" href="${href.replaceAll('&', '&amp;')}"></head><body><main>Original article</main></body></html>`,
            { headers: { 'content-type': 'text/html' } },
          )
          if (target === linked) return Response.redirect(other)
          return new Response('# Different article', { headers: { 'content-type': 'text/markdown' } })
        },
      }
      const tool = createWebFetchTool(createTestReader({
        fetchDocument: createWebDocumentFetcher(network),
        fetchLinkedMarkdown: (target, pageUrl, signal) => fetchLinkedMarkdown(target, pageUrl, network, signal),
      }))
      const ctx = { projectDir: '.', additionalDirs: [], abortSignal: activeSignal }
      for (const input of [{ url }, { url, pattern: 'article' }]) {
        const result = await tool.execute(input, ctx)
        assert.equal(result.isError, false)
        assert.ok(result.data.includes(`<${url}> "whycode:source"`))
        assert.match(result.data, /1\tOriginal article/)
        assert.doesNotMatch(result.data, /Different/)
      }
      assert.equal((await tool.execute({ url: other, pattern: 'article' }, ctx)).isError, true)
      assert.deepEqual(calls, href === linked ? [url, linked] : [url])
    }
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
      fetchLinkedMarkdown: async () => assert.fail('PDF 不应请求 Markdown'),
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
      patterns: ['anything'],
      offset: 1,
      maxResults: 1,
    }, activeSignal), /ReadFile/)
  })
})

function page(result: WebFetchResponse): WebFetchPageResponse {
  assert.equal(result.kind, 'page')
  if (result.kind !== 'page') throw new Error('期望文本网页结果')
  return result
}
