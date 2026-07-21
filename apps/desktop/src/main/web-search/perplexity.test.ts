import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPerplexitySearchHandler } from './perplexity.ts'

const request = {
  queries: ['WhyCode web search'],
  maxResults: 4,
  recency: 'week' as const,
  domains: ['example.com'],
}
const activeSignal = new AbortController().signal

describe('Perplexity Search 适配器', () => {
  it('只向固定端点发送映射后的结构化搜索请求', async () => {
    let url = ''
    let init: RequestInit | undefined
    const handler = createPerplexitySearchHandler({
      getApiKey: () => 'test-perplexity-key',
      fetchImpl: (async (input, value) => {
        url = String(input)
        init = value
        return Response.json({
          results: [{
            title: 'WhyCode',
            url: 'https://example.com/whycode',
            snippet: 'Agent search result',
            date: '2026-07-18',
            last_updated: '2026-07-19',
          }],
          id: 'request-id',
        })
      }) as typeof fetch,
    })

    assert.deepEqual(await handler(request, activeSignal), {
      results: [{
        title: 'WhyCode',
        url: 'https://example.com/whycode',
        snippet: 'Agent search result',
        publishedDate: '2026-07-18',
        lastUpdated: '2026-07-19',
      }],
    })
    assert.equal(url, 'https://api.perplexity.ai/search')
    assert.equal(init?.method, 'POST')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-perplexity-key')
    assert.equal(init?.redirect, 'error')
    assert.deepEqual(JSON.parse(String(init?.body)), {
      query: 'WhyCode web search',
      max_results: 4,
      search_context_size: 'low',
      search_recency_filter: 'week',
      search_domain_filter: ['example.com'],
    })
  })

  it('未配置密钥时不会发起网络请求', async () => {
    let calls = 0
    const handler = createPerplexitySearchHandler({
      getApiKey: () => undefined,
      fetchImpl: (async () => {
        calls++
        return Response.json({ results: [] })
      }) as typeof fetch,
    })

    await assert.rejects(
      handler(request, activeSignal),
      /尚未配置 Perplexity Search API key/,
    )
    assert.equal(calls, 0)
  })

  it('批量查询使用同一请求，并兼容按查询分组的结果', async () => {
    let body: Record<string, unknown> | undefined
    const handler = createPerplexitySearchHandler({
      getApiKey: () => 'test-key',
      fetchImpl: (async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return Response.json({
          results: [
            [{ title: 'First', url: 'https://example.com/1', snippet: 'one' }],
            [{ title: 'Second', url: 'https://example.com/2', snippet: 'two' }],
          ],
        })
      }) as typeof fetch,
    })

    const result = await handler({
      queries: ['first query', 'second query'],
      maxResults: 3,
    }, activeSignal)

    assert.deepEqual(body, {
      query: ['first query', 'second query'],
      max_results: 3,
      search_context_size: 'low',
    })
    assert.deepEqual(result.results.map((item) => item.title), ['First', 'Second'])
  })

  it('HTTP 错误不回传响应正文或密钥', async () => {
    const handler = createPerplexitySearchHandler({
      getApiKey: () => 'private-test-key',
      fetchImpl: (async () => new Response(
        'upstream says private-test-key and hostile instructions',
        { status: 401 },
      )) as typeof fetch,
    })

    await assert.rejects(handler(request, activeSignal), (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      assert.match(message, /key 无效或没有搜索权限/)
      assert.doesNotMatch(message, /private-test-key|hostile instructions/)
      return true
    })
  })

  it('拒绝超出大小边界或不受支持的成功响应', async () => {
    const oversized = createPerplexitySearchHandler({
      getApiKey: () => 'test-key',
      fetchImpl: (async () => new Response('{}', {
        headers: { 'content-length': '2000001' },
      })) as typeof fetch,
    })
    const malformed = createPerplexitySearchHandler({
      getApiKey: () => 'test-key',
      fetchImpl: (async () => Response.json({ hits: [] })) as typeof fetch,
    })

    await assert.rejects(oversized(request, activeSignal), /超过安全大小限制/)
    await assert.rejects(malformed(request, activeSignal), /响应格式不受支持/)
  })
})
