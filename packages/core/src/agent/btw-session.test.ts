import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import type { BtwTurnContext, BtwTurnResult } from '../session/btw.ts'
import { createWebSearchTool } from '../tools/web-search/index.ts'
import { createWebFetchTool, createWebFindTool, WebPageError } from '../tools/web-page/index.ts'
import { AgentSession } from './session.ts'

describe('BTW 独立侧对话', () => {
  it('复用文件工具并把读取结果留在 BTW 续问中，不修改 Main 消息历史', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        finalStep('主回答'),
        readFileStep(),
        finalStep('第一轮侧回答'),
        finalStep('第二轮侧回答'),
      ],
    })
    const session = createSession(model, {
      mainTools: [
        createWebSearchTool({ search: async () => ({ results: [] }) }),
        createWebFetchTool({ fetchPage: async () => { throw new Error('未使用') } }),
        createWebFindTool({ findInPage: async () => { throw new Error('未使用') } }),
      ],
    })
    assert.equal(await session.handleUserMessage('主问题'), 'completed')
    const mainSnapshot = session.captureMessageSnapshot()

    const first = btwContext('btw', '第一轮侧问题', [])
    const firstSettled: BtwTurnResult[] = []
    assert.equal(await session.handleBtwMessage(first, lifecycle(firstSettled)), 'completed')
    assert.equal(firstSettled[0]?.assistantText, '第一轮侧回答')
    assert.deepEqual(session.captureMessageSnapshot(), mainSnapshot)

    const second = btwContext('bbtw', '第二轮侧问题', [{
      inputId: first.inputId,
      conversationId: first.conversationId,
      turnIndex: 1,
      mode: 'btw',
      text: first.text,
      attachments: [],
      outcome: 'completed',
      assistantText: '第一轮侧回答',
      toolSteps: firstSettled[0]!.toolSteps,
    }], first.conversationId, 2)
    const secondSettled: BtwTurnResult[] = []
    assert.equal(await session.handleBtwMessage(second, lifecycle(secondSettled)), 'completed')
    assert.equal(secondSettled[0]?.assistantText, '第二轮侧回答')
    assert.deepEqual(session.captureMessageSnapshot(), mainSnapshot)

    const firstSideCall = model.doStreamCalls[1]!
    const secondSideCall = model.doStreamCalls[3]!
    const expectedTools = ['ReadFile', 'ListDir', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'WebFind']
    assert.deepEqual(firstSideCall.tools?.map((tool) => tool.name), expectedTools)
    assert.deepEqual(secondSideCall.tools?.map((tool) => tool.name), expectedTools)
    assert.equal(firstSettled[0]!.toolSteps?.length, 1)
    assert.match(JSON.stringify(model.doStreamCalls[2]!.prompt), /interface ToolDefinition/)
    assert.match(JSON.stringify(secondSideCall.prompt), /interface ToolDefinition/)
    assert.match(JSON.stringify(firstSideCall.prompt), /主问题/)
    assert.match(JSON.stringify(firstSideCall.prompt), /主回答/)
    assert.match(JSON.stringify(firstSideCall.prompt), /第一轮侧问题/)
    assert.doesNotMatch(JSON.stringify(firstSideCall.prompt), /第一轮侧回答/)
    assert.match(JSON.stringify(secondSideCall.prompt), /第一轮侧问题/)
    assert.match(JSON.stringify(secondSideCall.prompt), /第一轮侧回答/)
    assert.match(JSON.stringify(secondSideCall.prompt), /第二轮侧问题/)
    assert.match(JSON.stringify(secondSideCall.prompt), /侧问答独立于主任务/)
  })

  it('续接被停止的侧轮次时保留原输入、部分回复与用户中断标记', async () => {
    const model = new MockLanguageModelV4({ doStream: [finalStep('续接回答')] })
    const session = createSession(model)
    const conversationId = randomUUID()
    const context = btwContext('bbtw', '换一个角度回答', [{
      inputId: randomUUID(),
      conversationId,
      turnIndex: 1,
      mode: 'btw',
      text: '第一轮侧问题',
      attachments: [],
      outcome: 'stopped',
      assistantText: '尚未说完的部分',
      interruptionReason: 'user-cancel',
    }], conversationId, 2)

    assert.equal(await session.handleBtwMessage(context, lifecycle([])), 'completed')
    const request = JSON.stringify(model.doStreamCalls[0]?.prompt)
    assert.match(request, /第一轮侧问题/)
    assert.match(request, /尚未说完的部分/)
    assert.match(request, /whycode-turn-aborted/)
    assert.match(request, /上一回合已被用户主动停止/)
    assert.match(request, /换一个角度回答/)
  })

  it('网页工具复用 Main 的记住授权与全自动设置，失败仍交回模型判断', async () => {
    for (const mode of ['default', 'auto'] as const) {
      const model = new MockLanguageModelV4({ doStream: [
        toolStep('WebSearch', { query: '主问题' }), finalStep('主回答'),
        toolStep('WebSearch', { query: '侧问题' }),
        toolStep('WebFetch', { url: 'https://example.com/private' }), finalStep('来源无法访问'),
      ] })
      let approvals = 0
      let searches = 0
      const session = createSession(model, {
        mainTools: [
          createWebSearchTool({ search: async () => { searches++; return { results: [] } } }),
          createWebFetchTool({ fetchPage: async () => { throw new WebPageError('网页需要登录') } }),
        ],
        requestApproval: async () => { approvals++; return { approved: true, remember: true } },
      })
      session.setPermissionMode(mode)
      await session.handleUserMessage('主问题')
      const snapshot = session.captureMessageSnapshot()
      const results: BtwTurnResult[] = []
      await session.handleBtwMessage(btwContext('btw', '侧问题', []), lifecycle(results))
      assert.equal(searches, 2)
      assert.equal(approvals, mode === 'auto' ? 0 : 2)
      assert.equal(results[0]?.outcome, 'completed')
      assert.deepEqual(results[0]?.toolSteps?.[1]?.toolErrors, ['btw-WebFetch'])
      assert.match(JSON.stringify(model.doStreamCalls[4]?.prompt), /网页需要登录/)
      assert.deepEqual(session.captureMessageSnapshot(), snapshot)
    }
  })

  it('停止 BTW 会取消正在等待的网页工具，并结束当前轮次', async () => {
    let onStarted!: () => void
    const started = new Promise<void>((resolve) => { onStarted = resolve })
    let signal: AbortSignal | undefined
    const model = new MockLanguageModelV4({
      doStream: [toolStep('WebFetch', { url: 'https://example.com/slow' })],
    })
    const session = createSession(model, {
      mainTools: [createWebFetchTool({ fetchPage: async (_request, abortSignal) => {
        signal = abortSignal
        onStarted()
        return new Promise((_resolve, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error('已取消')), { once: true })
        })
      } })],
    })
    session.setPermissionMode('auto')
    const results: BtwTurnResult[] = []
    const running = session.handleBtwMessage(btwContext('btw', '读取网页', []), lifecycle(results))
    await started
    session.abort()
    assert.equal(await running, 'aborted')
    assert.equal(signal?.aborted, true)
    assert.equal(results[0]?.interruptionReason, 'user-cancel')
    assert.equal(model.doStreamCalls.length, 1)
    assert.deepEqual(session.captureMessageSnapshot(), [])
  })
})

function createSession(
  model: MockLanguageModelV4,
  options: Partial<ConstructorParameters<typeof AgentSession>[0]> = {},
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
    ...options,
  })
}

function lifecycle(results: BtwTurnResult[]) {
  return {
    emit: (_event: CoreEvent) => {},
    onSettled: async (result: BtwTurnResult) => {
      results.push(result)
    },
  }
}

function btwContext(
  mode: 'btw' | 'bbtw',
  text: string,
  history: BtwTurnContext['history'],
  conversationId: string = randomUUID(),
  turnIndex = 1,
): BtwTurnContext {
  return {
    inputId: randomUUID(),
    conversationId,
    turnIndex,
    mode,
    text,
    attachments: [],
    history,
  }
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:btw',
    displayName: 'BTW Mock',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: true,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
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
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
        },
      ],
    }),
  }
}

function readFileStep() {
  return toolStep('ReadFile', { path: fileURLToPath(new URL('../tools/tool.ts', import.meta.url)) })
}

function toolStep(toolName: string, input: Record<string, unknown>) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: `btw-${toolName}`, toolName,
          input: JSON.stringify(input),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
        },
      ],
    }),
  }
}
