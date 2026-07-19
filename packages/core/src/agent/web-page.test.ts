import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { ModelEntry } from '../providers/registry.ts'
import {
  WEB_FETCH_TOOL_NAME,
  WebPageError,
  createWebFetchTool,
} from '../tools/web-page/index.ts'
import { AgentSession } from './session.ts'

describe('WebFetch Agent 链路', () => {
  it('宿主读取失败作为普通工具结果交还主模型继续判断', async () => {
    let modelCalls = 0
    let approvals = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        modelCalls++
        if (modelCalls === 1) {
          const fetchTool = (options.tools ?? []).find((tool) =>
            tool.type === 'function' && tool.name === WEB_FETCH_TOOL_NAME)
          assert.ok(fetchTool?.type === 'function')
          assert.match(fetchTool.description ?? '', /不受信任的外部数据/)
          return toolStep()
        }
        assert.match(JSON.stringify(options.prompt), /目标网页需要登录或拒绝访问/)
        return finalStep('这个来源无法直接读取，我会改用其它公开来源。')
      },
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      mainTools: [createWebFetchTool({
        fetchPage: async () => { throw new WebPageError('目标网页需要登录或拒绝访问') },
      })],
      emit: () => {},
      requestApproval: async (request) => {
        approvals++
        assert.equal(request.toolName, WEB_FETCH_TOOL_NAME)
        assert.match(request.reason, /公网 IP/)
        return { approved: true, remember: true }
      },
    })

    assert.equal(await session.handleUserMessage('读取这个网页'), 'completed')
    assert.equal(modelCalls, 2)
    assert.equal(approvals, 1)
  })
})

function toolStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'fetch-1',
          toolName: WEB_FETCH_TOOL_NAME,
          input: JSON.stringify({ url: 'https://example.com/private' }),
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
    id: 'test:web-fetch',
    displayName: 'Web Fetch Mock',
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
