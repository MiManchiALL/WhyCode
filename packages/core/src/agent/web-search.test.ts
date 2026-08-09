import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import {
  WEB_SEARCH_TOOL_NAME,
  WebSearchError,
  createWebSearchTool,
  type WebSearchRequest,
} from '../tools/web-search/index.ts'
import { AgentSession } from './session.ts'

describe('WebSearch Agent 链路', () => {
  it('受管默认工作区的普通 Main 可搜索，会话记住后不重复隐私审批', async () => {
    let modelCall = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCall++
        const searchTool = (options.tools ?? []).find((tool) =>
          tool.type === 'function' && tool.name === WEB_SEARCH_TOOL_NAME)
        assert.ok(searchTool?.type === 'function')
        assert.match(searchTool.description ?? '', /不受信任的外部数据/)
        if (modelCall === 1) return toolStep('WhyCode current release', 'search-1')
        assert.equal(
          JSON.stringify(options.prompt).includes('https://example.com/current'),
          true,
        )
        if (modelCall === 2) return toolStep('WhyCode official docs', 'search-2')
        return finalStep('已根据网页来源完成研究。')
      },
    })
    const searches: WebSearchRequest[] = []
    const events: CoreEvent[] = []
    let approvals = 0
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      mainTools: [createWebSearchTool({
        search: async (request) => {
          searches.push(request)
          return {
            results: [{
              title: 'WhyCode source',
              url: request.queries[0]?.includes('current')
                ? 'https://example.com/current'
                : 'https://example.com/docs',
              snippet: 'A cited search result',
            }],
          }
        },
      })],
      emit: (event) => events.push(event),
      requestApproval: async (request) => {
        approvals++
        assert.equal(request.toolName, WEB_SEARCH_TOOL_NAME)
        assert.match(request.reason, /搜索词.*外部搜索服务/)
        return { approved: true, remember: true }
      },
    })

    assert.equal(await session.handleUserMessage('研究 WhyCode 的当前资料'), 'completed')
    assert.deepEqual(searches.map((search) => search.queries), [
      ['WhyCode current release'],
      ['WhyCode official docs'],
    ])
    assert.equal(approvals, 1)
    assert.equal(
      events.filter((event) =>
        event.type === 'tool-start' && event.toolName === WEB_SEARCH_TOOL_NAME).length,
      2,
    )
  })

  it('同一步的并行搜索失败都会收尾，并把错误交给模型继续判断', async () => {
    const events: CoreEvent[] = []
    let modelCalls = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++
        if (modelCalls === 1) return parallelToolStep()
        const prompt = JSON.stringify(options.prompt)
        assert.equal(
          prompt.match(/尚未配置网页搜索密钥/gu)?.length,
          2,
          '模型必须同时收到本步的两个错误结果',
        )
        return finalStep('网页搜索尚未配置，请先在连接设置中配置密钥。')
      },
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      mainTools: [createWebSearchTool({
        search: async () => {
          throw new WebSearchError('尚未配置网页搜索密钥')
        },
      })],
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true, remember: true }),
    })

    assert.equal(await session.handleUserMessage('搜索今天的热点'), 'completed')
    assert.equal(modelCalls, 2)
    assert.deepEqual(
      events
        .flatMap((event) => event.type === 'tool-end' && event.isError
          ? [event.toolUseId]
          : [])
        .sort(),
      ['search-parallel-1', 'search-parallel-2'],
    )
    assert.equal(
      events.findLast((event) => event.type === 'agent-status')?.status,
      'idle',
    )
  })
})

function toolStep(query: string, toolCallId: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId,
          toolName: WEB_SEARCH_TOOL_NAME,
          input: JSON.stringify({ query, max_results: 5 }),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function parallelToolStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'search-parallel-1',
          toolName: WEB_SEARCH_TOOL_NAME,
          input: JSON.stringify({ query: '今日热点新闻', max_results: 8 }),
        },
        {
          type: 'tool-call' as const,
          toolCallId: 'search-parallel-2',
          toolName: WEB_SEARCH_TOOL_NAME,
          input: JSON.stringify({ query: '热搜榜 今天', max_results: 8 }),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function finalStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: text },
        { type: 'text-end' as const, id: 'final' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:web-search',
    displayName: 'Web Search Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
