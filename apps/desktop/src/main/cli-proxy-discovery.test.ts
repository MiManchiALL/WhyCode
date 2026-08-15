import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  discoverCliProxyRoutes,
  unresolvedCliProxyProfiles,
} from './cli-proxy-discovery.ts'

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
        { id: 'gemini-3.7-flash' },
        { id: 'gemini-3.7-flash-high' },
        { id: 'gpt-5.6-sol' },
        { id: 'gpt-5.6-terra' },
        { id: 'unreviewed-model' },
      ] })
    })

    assert.equal(request?.input, 'http://127.0.0.1:8317/v1/models')
    assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer secret')
    assert.equal(request?.init?.redirect, 'error')
    assert.deepEqual(routes, {
      'google:gemini-3.1-pro-preview': 'gemini-pro-agent',
      'google:gemini-3.7-flash': 'gemini-3.7-flash-high',
      'openai:gpt-5.6-sol': 'gpt-5.6-sol',
      'openai:gpt-5.6-terra': 'gpt-5.6-terra',
    })
  })

  it('明确报告当前实例没有公布的已选型号', () => {
    assert.deepEqual(unresolvedCliProxyProfiles(
      ['google:gemini-3.1-pro-preview', 'openai:gpt-5.6-sol'],
      { 'openai:gpt-5.6-sol': 'gpt-5.6-sol' },
    ), ['google:gemini-3.1-pro-preview'])
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
