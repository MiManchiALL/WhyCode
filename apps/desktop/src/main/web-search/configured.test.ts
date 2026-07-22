import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { WhycodeConfig } from '../config.ts'
import { createConfiguredWebSearchHandler } from './configured.ts'

const request = { queries: ['WhyCode'], maxResults: 1 }
const activeSignal = new AbortController().signal

describe('网页搜索后端分派', () => {
  it('每次调用读取当前配置并只请求选中的固定后端', async () => {
    let config: WhycodeConfig = {
      providers: {},
      webSearch: {
        activeProvider: 'perplexity',
        perplexity: { apiKey: 'perplexity-key' },
        tavily: { apiKey: 'tavily-key' },
      },
    }
    const calls: string[] = []
    const handler = createConfiguredWebSearchHandler({
      getConfig: () => config,
      fetchImpl: async (input) => {
        calls.push(input)
        return Response.json({ results: [] })
      },
    })

    await handler(request, activeSignal)
    config = {
      ...config,
      webSearch: { ...config.webSearch!, activeProvider: 'tavily' },
    }
    await handler(request, activeSignal)

    assert.deepEqual(calls, [
      'https://api.perplexity.ai/search',
      'https://api.tavily.com/search',
    ])
  })

  it('损坏的活动选择不会越过已有密钥调用未配置后端', async () => {
    const calls: string[] = []
    const handler = createConfiguredWebSearchHandler({
      getConfig: () => ({
        providers: {},
        webSearch: {
          activeProvider: 'tavily',
          perplexity: { apiKey: 'perplexity-key' },
        },
      }),
      fetchImpl: async (input) => {
        calls.push(input)
        return Response.json({ results: [] })
      },
    })

    await handler(request, activeSignal)
    assert.deepEqual(calls, ['https://api.perplexity.ai/search'])
  })
})
