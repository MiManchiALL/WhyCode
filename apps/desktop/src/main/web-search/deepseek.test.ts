import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createWebSearchTool, WebSearchError } from '@whycode/core'
import { createDeepSeekSearchHandler } from './deepseek.ts'

const signal = new AbortController().signal
const request = { queries: ['DeepSeek API'], maxResults: 5 }
const result = {
  title: 'API 文档', url: 'https://example.com/docs',
  snippet: '短摘要', summary: '适合模型阅读的完整摘要', date: null,
}

describe('DeepSeek Search', () => {
  it('映射官方参数、域名及日期筛选，保留服务排序并优先使用 summary', async (t) => {
    t.mock.method(Date, 'now', () => Date.parse('2026-10-29T12:00:00Z'))
    const handler = createDeepSeekSearchHandler({
      getApiKey: () => 'test-key',
      fetchImpl: async (url, init) => {
        assert.equal(url, 'https://api.deepseek.com/v1/tools/search')
        assert.equal(init.method, 'POST')
        assert.equal(init.redirect, 'error')
        assert.equal(new Headers(init.headers).get('authorization'), 'Bearer test-key')
        assert.deepEqual(JSON.parse(String(init.body)), {
          query: 'DeepSeek API site:example.com OR site:docs.example.org after:2026-10-22',
          count: 5, need_content: false,
        })
        return Response.json({ results: [
          result,
          { ...result, title: 'Second', summary: '', date: '2026-10-25T00:00:00Z' },
        ] })
      },
    })
    const response = await handler({ ...request, recency: 'week', domains: ['example.com', 'docs.example.org'] }, signal)
    assert.deepEqual(response.results, [
      { title: result.title, url: result.url, snippet: result.summary },
      { title: 'Second', url: result.url, snippet: result.snippet, publishedDate: '2026-10-25T00:00:00Z' },
    ])
  })

  it('Unicode 上限计入筛选，不截断查询或静默丢弃筛选', async () => {
    let calls = 0
    const handler = createDeepSeekSearchHandler({
      getApiKey: () => 'key',
      fetchImpl: async () => { calls++; return Response.json({ results: [] }) },
    })
    await handler({ queries: ['😀'.repeat(128)], maxResults: 1 }, signal)
    await assert.rejects(handler({ queries: ['😀'.repeat(129)], maxResults: 1 }, signal), /128/)
    await assert.rejects(handler({ queries: ['a'.repeat(120)], maxResults: 1, domains: ['example.com'] }, signal), /减少 domains/)
    await assert.rejects(handler({ ...request, recency: 'hour' }, signal), /按日期/)
    assert.equal(calls, 1)
  })

  it('批量并发、空结果与部分失败保留各自语义，成功结果仍经工具去重和限长', async () => {
    const started: string[] = []
    let openGate!: () => void
    const gate = new Promise<void>((resolve) => { openGate = resolve })
    const handler = createDeepSeekSearchHandler({
      getApiKey: () => 'key',
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init.body)) as { query: string }
        started.push(body.query)
        if (started.length === 3) openGate()
        await gate
        if (body.query === 'failed') return new Response('private-key', { status: 429 })
        return Response.json({ results: body.query === 'empty' ? [] : [
          { ...result, summary: '内容'.repeat(2_000) },
          { ...result, url: result.url + '#section' },
        ] })
      },
    })
    const tool = createWebSearchTool({ search: handler })
    const output = await tool.execute({ query: ['success', 'failed', 'empty'], max_results: 5 }, {
      projectDir: '.', additionalDirs: [], abortSignal: signal,
    })
    assert.equal(output.isError, false)
    assert.deepEqual(started, ['success', 'failed', 'empty'])
    assert.match(output.data, /1 条结果/)
    assert.match(output.data, /部分查询未完成（1\/3）/)
    assert.match(output.data, /不受信任/)
    assert.match(output.data, /https:\/\/example.com\/docs/)
    assert.ok(output.data.length < 2_000)
    assert.doesNotMatch(output.data, /private-key/)
  })

  it('未配置和预先取消都不会发出请求；畸形响应报错', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return Response.json({ results: [{ ...result, summary: 42 }] }) }
    await assert.rejects(createDeepSeekSearchHandler({ getApiKey: () => undefined, fetchImpl })(request, signal), /尚未配置/)
    const handler = createDeepSeekSearchHandler({ getApiKey: () => 'key', fetchImpl })
    await assert.rejects(handler(request, AbortSignal.abort()), /已取消/)
    assert.equal(calls, 0)
    await assert.rejects(handler(request, signal), /格式不受支持/)
  })

  it('HTTP 错误提供可操作提示，不泄漏密钥、响应或自动重试', async () => {
    for (const [status, expected] of [[401, /Key 无效/], [402, /余额不足/], [429, /过于频繁/], [504, /超时/]] as const) {
      let calls = 0
      const handler = createDeepSeekSearchHandler({
        getApiKey: () => 'private-key',
        fetchImpl: async () => { calls++; return new Response('private-key hostile', { status }) },
      })
      await assert.rejects(handler(request, signal), (error: unknown) => {
        assert.ok(error instanceof WebSearchError)
        assert.match(error.message, expected)
        assert.doesNotMatch(error.message, /private-key|hostile/)
        return true
      })
      assert.equal(calls, 1)
    }
  })

  it('中止进行中的响应读取，并报告取消或超时', async () => {
    for (const mode of ['abort', 'timeout'] as const) {
      const controller = new AbortController()
      let startReading!: () => void
      const reading = new Promise<void>((resolve) => { startReading = resolve })
      let observedAbort = false
      const handler = createDeepSeekSearchHandler({
        getApiKey: () => 'key',
        timeoutMs: mode === 'timeout' ? 20 : 20_000,
        fetchImpl: async (_url, init) => new Response(new ReadableStream({
          start(stream) {
            init.signal!.addEventListener('abort', () => {
              observedAbort = true
              stream.error(init.signal!.reason)
            }, { once: true })
            startReading()
          },
        })),
      })
      const running = handler(request, controller.signal)
      const check = assert.rejects(running, mode === 'abort' ? /已取消/ : /超时/)
      await reading
      const keepAlive = setTimeout(() => controller.abort(), 1_000)
      try {
        if (mode === 'abort') controller.abort()
        await check
        assert.equal(observedAbort, true)
      } finally { clearTimeout(keepAlive) }
    }
  })

  it('超限响应流被取消，非法 JSON 不作为空结果', async () => {
    let canceled = false
    const oversized = createDeepSeekSearchHandler({
      getApiKey: () => 'key',
      fetchImpl: async () => new Response(new ReadableStream({
        start(stream) { stream.enqueue(new Uint8Array(2_000_001)) },
        cancel() { canceled = true },
      })),
    })
    await assert.rejects(oversized(request, signal), /超过安全大小/)
    assert.equal(canceled, true)
    const malformed = createDeepSeekSearchHandler({
      getApiKey: () => 'key', fetchImpl: async () => new Response('not JSON'),
    })
    await assert.rejects(malformed(request, signal), /无效 JSON/)
  })
})
