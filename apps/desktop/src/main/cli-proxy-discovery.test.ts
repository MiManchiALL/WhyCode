import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  discoverCliProxyRoutes,
  applyDiscoveredCliProxyRoutes,
  createCliProxyRouteSynchronizer,
} from './cli-proxy-discovery.ts'
import type { WhycodeConfig } from './config.ts'
import { listModelConnections } from './model-connections.ts'

describe('CLIProxyAPI 实例模型目录', () => {
  it('携带密钥读取 /models，并只返回审核过且实际公布的路由', async () => {
    let request: { input: string; init?: RequestInit } | undefined
    const routes = await discoverCliProxyRoutes({
      apiKey: 'secret',
      baseURL: 'http://127.0.0.1:8317/v1/',
    }, async (input, init) => {
      request = { input, init }
      return Response.json({ data: [
        { id: 'gemini-pro-agent' },
        { id: 'gemini-3.8-flash' },
        { id: 'gemini-3.8-flash-high' },
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-5.6-terra' },
        { id: 'gpt-6-astra' },
        { id: 'unreviewed-model' },
      ] })
    })

    assert.equal(request?.input, 'http://127.0.0.1:8317/v1/models')
    assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer secret')
    assert.equal(request?.init?.redirect, 'error')
    assert.deepEqual(routes, {
      'google:gemini-3.1-pro-preview': 'gemini-pro-agent',
      'google:gemini-3.8-flash': 'gemini-3.8-flash-high',
      'openai:gpt-5.6-sol': 'gpt-5.6-sol',
      'openai:gpt-5.6-terra': 'gpt-5.6-terra',
      'openai:gpt-6-astra': 'gpt-6-astra',
    })
  })

  it('并发刷新共享请求，目录缺项保留选择，后续刷新恢复能力且不覆盖新连接', async () => {
    const modelId = 'google:gemini-3.8-flash'
    const config: WhycodeConfig = {
      providers: {}, defaultModel: `cliproxyapi:${modelId}`,
      cliProxyApi: {
        apiKey: 'key', baseURL: 'http://127.0.0.1:8317/v1',
        modelIds: [modelId], modelRoutes: { [modelId]: 'gemini-3.8-flash-high' },
      },
    }
    let current = config
    let advertised: string[] = []
    let requests = 0
    const synchronize = createCliProxyRouteSynchronizer(
      () => current,
      async (next) => { current = next },
      async () => {
        requests++
        return Response.json({ data: advertised.map((id) => ({ id })) })
      },
    )
    const first = synchronize()
    assert.equal(synchronize(), first)
    await first
    assert.equal(requests, 1)
    const missing = current
    assert.deepEqual(missing.cliProxyApi?.modelIds, [modelId])
    assert.equal(missing.defaultModel, config.defaultModel)
    assert.deepEqual(missing.cliProxyApi?.modelRoutes, {})
    const unavailable = listModelConnections(missing, config.defaultModel).at(-1)!
    assert.equal(unavailable.hasKey, true)
    assert.equal(unavailable.available, false)
    assert.equal(unavailable.supportsImageInput, true)
    assert.equal(unavailable.imageInputMode, 'none')
    assert.match(unavailable.unavailableReason!, /实例没有公布/)
    advertised = ['gemini-3.8-flash-high']
    await synchronize()
    assert.equal(requests, 2)
    assert.deepEqual(current, config)
    const available = listModelConnections(current, config.defaultModel).at(-1)!
    assert.equal(available.available, true)
    assert.equal(available.imageInputMode, 'native')
    const changed = { ...config, cliProxyApi: { ...config.cliProxyApi!, apiKey: 'new-key' } }
    assert.equal(applyDiscoveredCliProxyRoutes(changed, config.cliProxyApi!, {}), changed)
  })

  it('拒绝错误状态和畸形模型目录', async () => {
    await assert.rejects(
      discoverCliProxyRoutes({
        apiKey: 'secret',
        baseURL: 'http://127.0.0.1:8317/v1',
      }, async () => new Response('', { status: 401 })),
      /HTTP 401/,
    )
    await assert.rejects(
      discoverCliProxyRoutes({
        apiKey: 'secret',
        baseURL: 'http://127.0.0.1:8317/v1',
      }, async () => Response.json({ models: [] })),
      /返回格式不正确/,
    )
    await assert.rejects(
      discoverCliProxyRoutes({
        apiKey: 'secret',
        baseURL: 'http://127.0.0.1:8317/v1',
      }, async () => new Response('', { headers: { 'content-length': '2000001' } })),
      /超过安全大小限制/,
    )
  })
})
