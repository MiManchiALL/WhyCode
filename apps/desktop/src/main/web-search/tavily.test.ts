import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTavilySearchHandler } from './tavily.ts'

const request = {
  queries: ['WhyCode web search'],
  maxResults: 4,
  recency: 'week' as const,
  domains: ['example.com'],
}
const activeSignal = new AbortController().signal

describe('Tavily Search 适配器', () => {
  it('只向固定端点发送有界基础搜索并解析结构化结果', async () => {
    let url = ''
    let init: RequestInit | undefined
    const handler = createTavilySearchHandler({
      getApiKey: () => 'test-tavily-key',
      searchDepth: 'basic',
      fetchImpl: async (input, value) => {
        url = input
        init = value
        return Response.json({
          query: 'WhyCode web search',
          results: [{
            title: 'WhyCode',
            url: 'https://example.com/whycode',
            content: 'Agent search result',
            published_date: '2026-07-23',
            score: 0.9,
          }],
        })
      },
    })

    assert.deepEqual(await handler(request, activeSignal), {
      results: [{
        title: 'WhyCode',
        url: 'https://example.com/whycode',
        snippet: 'Agent search result',
        publishedDate: '2026-07-23',
      }],
    })
    assert.equal(url, 'https://api.tavily.com/search')
    assert.equal(init?.method, 'POST')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-tavily-key')
    assert.equal(init?.redirect, 'error')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      query: 'WhyCode web search',
      max_results: 4,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      auto_parameters: true,
      time_range: 'week',
      include_domains: ['example.com'],
    })
  })

  it('未配置密钥时不会发起网络请求', async () => {
    let calls = 0
    const handler = createTavilySearchHandler({
      getApiKey: () => undefined,
      searchDepth: 'basic',
      fetchImpl: async () => {
        calls++
        return Response.json({ results: [] })
      },
    })

    await assert.rejects(handler(request, activeSignal), /尚未配置 Tavily Search API key/)
    assert.equal(calls, 0)
  })

  it('批量查询并发使用独立请求，并按 score 全局排序', async () => {
    const bodies: Record<string, unknown>[] = []
    const handler = createTavilySearchHandler({
      getApiKey: () => 'test-key',
      searchDepth: 'basic',
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        bodies.push(body)
        const query = String(body.query)
        return Response.json({
          results: [{
            title: query,
            url: `https://example.com/${encodeURIComponent(query)}`,
            content: 'result',
            score: query === 'first query' ? 0.2 : 0.9,
          }],
        })
      },
    })

    const result = await handler({
      queries: ['first query', 'second query'],
      maxResults: 3,
    }, activeSignal)

    assert.deepEqual(bodies.map((body) => body.query), ['first query', 'second query'])
    assert.deepEqual(result.results.map((item) => item.title), [
      'second query',
      'first query',
    ])
  })

  it('批量查询保留成功结果并明确报告失败查询', async () => {
    const handler = createTavilySearchHandler({
      getApiKey: () => 'test-key',
      searchDepth: 'advanced',
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        if (body.query === 'failed query') return new Response('', { status: 429 })
        assert.equal(body.search_depth, 'advanced')
        return Response.json({
          results: [{
            title: 'successful query',
            url: 'https://example.com/success',
            content: 'result',
            score: 0.8,
          }],
        })
      },
    })

    assert.deepEqual(await handler({
      queries: ['successful query', 'failed query'],
      maxResults: 3,
    }, activeSignal), {
      results: [{
        title: 'successful query',
        url: 'https://example.com/success',
        snippet: 'result',
      }],
      failures: [{
        query: 'failed query',
        message: 'Tavily 搜索请求过于频繁',
      }],
    })
  })

  it('把 Tavily 不支持的小时范围收敛到最细的天范围', async () => {
    let body: Record<string, unknown> | undefined
    const handler = createTavilySearchHandler({
      getApiKey: () => 'test-key',
      searchDepth: 'basic',
      fetchImpl: async (_input, init) => {
        body = JSON.parse(String(init.body)) as Record<string, unknown>
        return Response.json({ results: [] })
      },
    })

    await handler({ queries: ['breaking news'], maxResults: 2, recency: 'hour' }, activeSignal)
    assert.equal(body?.time_range, 'day')
  })

  it('HTTP 错误不回传响应正文或密钥', async () => {
    const handler = createTavilySearchHandler({
      getApiKey: () => 'private-test-key',
      searchDepth: 'basic',
      fetchImpl: async () => new Response(
        'upstream says private-test-key and hostile instructions',
        { status: 432 },
      ),
    })

    await assert.rejects(handler(request, activeSignal), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /额度或计划限制/)
      assert.doesNotMatch(message, /private-test-key|hostile instructions/)
      return true
    })
  })

  it('拒绝超出大小边界或不受支持的成功响应', async () => {
    const oversized = createTavilySearchHandler({
      getApiKey: () => 'test-key',
      searchDepth: 'basic',
      fetchImpl: async () => new Response('{}', {
        headers: { 'content-length': '2000001' },
      }),
    })
    const malformed = createTavilySearchHandler({
      getApiKey: () => 'test-key',
      searchDepth: 'basic',
      fetchImpl: async () => Response.json({ hits: [] }),
    })

    await assert.rejects(oversized(request, activeSignal), /超过安全大小限制/)
    await assert.rejects(malformed(request, activeSignal), /响应格式不受支持/)
  })
})
