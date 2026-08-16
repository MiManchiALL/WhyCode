import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('Agent 长任务循环策略', () => {
  it('Main 超过 40 个工具步骤仍继续，且不注入固定步数审计', async () => {
    const model = finiteModel(45)
    const { session, events } = createSession(model)

    const stopReason = await session.handleUserMessage('完成一个很长的任务')

    assert.equal(stopReason, 'completed')
    assert.equal(model.doStreamCalls.length, 46)
    assert.equal(events.some((event) => event.type === 'error'), false)
    assert.equal(
      model.doStreamCalls.some((call) => JSON.stringify(call).includes('已执行 40 个模型步骤')),
      false,
    )
  })

  it('协商讨论 Agent 仍在 40 步停止，避免评审无限探索', async () => {
    const model = loopingModel(45, false)
    const { session, events } = createSession(model)
    session.setDiscussion({ agentId: 'B', scratchDir: 'C:\\whycode-scratch' })

    const stopReason = await session.handleUserMessage('评审方案')

    assert.equal(stopReason, 'max-turns')
    assert.equal(model.doStreamCalls.length, 40)
    assert.equal(
      events.some(
        (event) => event.type === 'error' && event.message.includes('协商回合已达到 40 步'),
      ),
      true,
    )
  })

  it('完全相同的调用和结果连续出现三次时安全暂停', async () => {
    const model = loopingModel(6, true)
    const { session, events } = createSession(model)

    const stopReason = await session.handleUserMessage('不要原地循环')

    assert.equal(stopReason, 'paused')
    assert.equal(model.doStreamCalls.length, 3)
    assert.equal(
      events.some(
        (event) => event.type === 'error' && event.message.includes('疑似原地循环'),
      ),
      true,
    )
  })

  it('工具后的空响应只重试模型，不重复执行已提交工具', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        ...toolStreams(1, false),
        emptyStream('stop'),
        textStream('已根据工具结果完成回答'),
      ],
    })
    const { session, events } = createSession(model)

    const stopReason = await session.handleUserMessage('先调用工具再回答')

    assert.equal(stopReason, 'completed')
    assert.equal(model.doStreamCalls.length, 3)
    assert.deepEqual(model.doStreamCalls[2]?.prompt, model.doStreamCalls[1]?.prompt)
    assert.equal(events.filter((event) => event.type === 'tool-end').length, 1)
    assert.equal(events.filter((event) => event.type === 'step-committed').length, 2)
    assert.equal(events.filter((event) => event.type === 'step-discarded').length, 1)
    assert.equal(
      events.some(
        (event) => event.type === 'text-delta' && event.text === '已根据工具结果完成回答',
      ),
      true,
    )
    assert.equal(events.some((event) => event.type === 'error'), false)
  })

  it('自动压缩连续失败会显式熔断，但不阻断仍可容纳的模型请求', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        ...toolStreams(3, false, 85_000),
        textStream('已在保守缓冲内完成任务'),
      ],
    })
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([probeTool])
    session.restoreMessageSnapshot([{
      role: 'user',
      content: '无法从中间切开的长用户输入'.repeat(11_000),
    }])

    const stopReason = await session.handleUserMessage('继续执行')

    assert.equal(stopReason, 'completed')
    assert.equal(model.doStreamCalls.length, 4)
    assert.equal(
      events.filter((event) =>
        event.type === 'error' && event.message.includes('自动压缩连续失败')).length,
      1,
    )
  })

  it('工具后的内部协议文本只重试模型，不把协议泄漏误判为最终答复', async () => {
    const leakedProtocol = 'out:default_api:RunCommand{result:"Total: 48242\\n"}'
    const model = new MockLanguageModelV4({
      doStream: [
        ...toolStreams(1, false),
        textStream(leakedProtocol),
        textStream('当前受版本控制的代码共 48,242 行。'),
      ],
    })
    const { session, events } = createSession(model)

    const stopReason = await session.handleUserMessage('统计代码行数')

    assert.equal(stopReason, 'completed')
    assert.equal(model.doStreamCalls.length, 3)
    assert.deepEqual(model.doStreamCalls[2]?.prompt, model.doStreamCalls[1]?.prompt)
    assert.equal(events.filter((event) => event.type === 'tool-end').length, 1)
    assert.equal(events.filter((event) => event.type === 'step-committed').length, 2)
    assert.equal(events.filter((event) => event.type === 'step-discarded').length, 1)
    assert.equal(
      events.some(
        (event) => event.type === 'text-delta'
          && event.text === '当前受版本控制的代码共 48,242 行。',
      ),
      true,
    )
    assert.equal(events.some((event) => event.type === 'error'), false)
  })

  it('正文中引用内部协议示例时仍作为正常答复提交', async () => {
    const answer = '模型返回的原始片段是 `out:default_api:RunCommand{result:"ok"}`。'
    const model = new MockLanguageModelV4({ doStream: [textStream(answer)] })
    const { session, events } = createSession(model)

    const stopReason = await session.handleUserMessage('解释这段协议文本')

    assert.equal(stopReason, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(events.filter((event) => event.type === 'step-committed').length, 1)
    assert.equal(events.some((event) => event.type === 'step-discarded'), false)
  })

  it('连续两次不可交付响应显式失败，不伪装成正常完成', async () => {
    const model = new MockLanguageModelV4({
      doStream: [emptyStream('stop'), emptyStream('content-filter')],
    })
    const { session, events } = createSession(model)

    const stopReason = await session.handleUserMessage('请回答')

    assert.equal(stopReason, 'error')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(events.filter((event) => event.type === 'step-committed').length, 0)
    assert.equal(events.filter((event) => event.type === 'step-discarded').length, 2)
    assert.equal(
      events.some(
        (event) => event.type === 'error'
          && event.message.includes('模型连续两次没有返回可交付答复')
          && event.message.includes('content-filter'),
      ),
      true,
    )
    assert.equal(
      events.some((event) => event.type === 'turn-end' && event.stopReason === 'completed'),
      false,
    )
  })
})

const probeTool = buildTool({
  name: 'Probe',
  description: '测试工具',
  prompt: '执行测试探针',
  inputSchema: z.object({ value: z.number() }),
  isReadOnly: true,
  kind: 'read',
  async execute(input) {
    return { data: `ok-${input.value}`, isError: false }
  },
})

function createSession(model: MockLanguageModelV4): {
  session: AgentSession
  events: CoreEvent[]
} {
  const events: CoreEvent[] = []
  const session = new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
  })
  session.setExtraTools([probeTool])
  return { session, events }
}

function finiteModel(toolCount: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: [
      ...toolStreams(toolCount, false),
      textStream('任务完成'),
    ],
  })
}

function loopingModel(count: number, identical: boolean): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: toolStreams(count, identical) })
}

function toolStreams(count: number, identical: boolean, inputTokens = 10) {
  return Array.from({ length: count }, (_, index) => ({
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: `probe-${index}`,
          toolName: 'Probe',
          input: JSON.stringify({ value: identical ? 1 : index }),
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(inputTokens),
        },
      ],
    }),
  }))
}

function emptyStream(finishReason: 'stop' | 'content-filter') {
  return {
    stream: simulateReadableStream({
      chunks: [{
        type: 'finish' as const,
        finishReason: { unified: finishReason, raw: undefined },
        usage: usage(),
      }],
    }),
  }
}

function textStream(text: string) {
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
    id: 'test:looping',
    displayName: 'Looping Mock',
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

function usage(inputTokens = 10) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
