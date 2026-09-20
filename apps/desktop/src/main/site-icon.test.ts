import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { siteIconUrl } from '../shared/site-icon.ts'
import { createSiteIconHandler } from './site-icon.ts'
import type { WebPageFetchInit } from './web-page/network.ts'

const resolveHost = async () => ({ endpoints: [{ address: '93.184.216.34' }] })
const request = (origin = 'https://example.com') => new Request(siteIconUrl(origin))

describe('正文站点图标', () => {
  it('只读取站点根图标，不携带凭据，并返回可复用的有界图片', async () => {
    let fetchedUrl = ''
    let fetchedInit: WebPageFetchInit | undefined
    const bytes = new Uint8Array([0, 0, 1, 0])
    const handler = createSiteIconHandler({ resolveHost, fetchImpl: async (url, init) => {
      fetchedUrl = url
      fetchedInit = init
      return new Response(bytes, { headers: { 'content-type': 'image/x-icon' } })
    } })
    const response = await handler(request())
    assert.equal(fetchedUrl, 'https://example.com/favicon.ico')
    assert.equal(fetchedInit?.credentials, 'omit')
    assert.equal(fetchedInit?.referrerPolicy, 'no-referrer')
    assert.equal(fetchedInit?.redirect, 'manual')
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'image/x-icon')
    assert.match(response.headers.get('cache-control') ?? '', /max-age=86(?:400|399)/u)
    assert.equal(response.headers.get('content-security-policy'), "default-src 'none'")
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes)
  })

  it('不能将图标入口用于请求页面、凭据网址或私网服务', async () => {
    let calls = 0
    const handler = createSiteIconHandler({ resolveHost, fetchImpl: async () => {
      calls++
      return new Response(null)
    } })
    for (const origin of [
      'https://example.com/page', 'https://example.com?secret=1',
      'https://user:password@example.com', 'file:///C:/private',
      'http://127.0.0.1', 'http://localhost', 'http://192.168.1.1',
    ]) assert.notEqual((await handler(request(origin))).status, 200)
    assert.equal((await handler(new Request(siteIconUrl('https://example.com'), { method: 'POST' }))).status, 405)
    assert.equal(calls, 0)
  })

  it('沿用公开 DNS 与逐跳重定向校验', async () => {
    let calls = 0
    const redirected = createSiteIconHandler({ resolveHost, fetchImpl: async () => {
      calls++
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/favicon.ico' } })
    } })
    assert.equal((await redirected(request())).status, 404)
    assert.equal(calls, 1)
    const privateDns = createSiteIconHandler({
      resolveHost: async () => ({ endpoints: [{ address: '10.0.0.1' }] }),
      fetchImpl: async () => { calls++; return new Response(null) },
    })
    assert.equal((await privateDns(request())).status, 404)
    assert.equal(calls, 1)
  })

  it('拒绝页面响应，声明或流式超过 64 KiB 都停止读取', async () => {
    for (const oversized of ['type', 'declared', 'streamed']) {
      let cancelled = false
      const handler = createSiteIconHandler({ resolveHost, fetchImpl: async () => new Response(
        new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array(oversized === 'streamed' ? 65_537 : 1)) },
          cancel() { cancelled = true },
        }),
        { headers: {
          'content-type': oversized === 'type' ? 'text/html' : 'image/png',
          ...(oversized === 'declared' ? { 'content-length': '65537' } : {}),
        } },
      ) })
      assert.notEqual((await handler(request())).status, 200)
      assert.equal(cancelled, true)
    }
  })

  it('离线或缺少图标静默返回失败，取消请求会中断网络读取', async () => {
    const missing = createSiteIconHandler({ resolveHost, fetchImpl: async () => { throw new Error('offline') } })
    const response = await missing(request())
    assert.equal(response.status, 404)
    assert.equal(await response.text(), '')
    assert.match(response.headers.get('cache-control') ?? '', /max-age=(?:300|299)/u)
    const controller = new AbortController()
    let cancelled = false
    const handler = createSiteIconHandler({ resolveHost, fetchImpl: async (_url, init) => {
      controller.abort()
      cancelled = init.signal?.aborted === true
      init.signal?.throwIfAborted()
      throw new Error('取消没有传入网络层')
    } })
    assert.equal((await handler(new Request(siteIconUrl('https://example.com'), { signal: controller.signal }))).status, 404)
    assert.equal(cancelled, true)
  })

  it('跨次读取复用近期图标和缺失结果，超出上限淘汰最久未访问的站点', async () => {
    const calls: string[] = []
    const handler = createSiteIconHandler({ resolveHost, fetchImpl: async url => {
      calls.push(url)
      return url.includes('missing.') ? new Response(null, { status: 404 })
        : new Response('icon', { headers: { 'content-type': 'image/png' } })
    } })
    await handler(request())
    await handler(request('https://missing.example.com'))
    await handler(request('https://missing.example.com'))
    assert.equal(calls.length, 2)
    for (let i = 0; i < 62; i++) await handler(request(`https://s${i}.example.com`))
    assert.equal(await (await handler(request())).text(), 'icon')
    assert.equal(calls.length, 64)
    await handler(request('https://new.example.com'))
    await handler(request('https://missing.example.com'))
    assert.equal(calls.length, 66)
    assert.equal(calls.at(-1), 'https://missing.example.com/favicon.ico')
  })

  it('取消的请求不缓存失败，稍后可以重新获取', async () => {
    const controller = new AbortController()
    let calls = 0
    const handler = createSiteIconHandler({ resolveHost, fetchImpl: async (_url, init) => {
      if (++calls === 1) { controller.abort(); init.signal?.throwIfAborted() }
      return new Response('icon', { headers: { 'content-type': 'image/png' } })
    } })
    await handler(new Request(siteIconUrl('https://example.com'), { signal: controller.signal }))
    assert.equal((await handler(request())).status, 200)
    assert.equal(calls, 2)
  })

  it('缺失结果五分钟后可重试，成功图标一天后重新读取', async context => {
    context.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
    let calls = 0
    const handler = createSiteIconHandler({ resolveHost, fetchImpl: async () => ++calls === 1
      ? new Response(null, { status: 404 })
      : new Response('icon', { headers: { 'content-type': 'image/png' } }),
    })
    assert.equal((await handler(request())).status, 404)
    assert.equal((await handler(request())).status, 404)
    assert.equal(calls, 1)
    context.mock.timers.tick(300_001)
    assert.equal((await handler(request())).status, 200)
    assert.equal((await handler(request())).status, 200)
    assert.equal(calls, 2)
    context.mock.timers.tick(86_400_001)
    assert.equal((await handler(request())).status, 200)
    assert.equal(calls, 3)
  })
})
