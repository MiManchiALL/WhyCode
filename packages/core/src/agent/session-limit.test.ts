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
})

const probeTool = buildTool({
  name: 'Probe',
  description: '测试工具',
  prompt: '执行测试探针',
  inputSchema: z.object({ value: z.number() }),
  isReadOnly: true,
  kind: 'read',
  availableWithoutProject: true,
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
    promptContext: { projectDir: null, osPlatform: 'win32' },
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
      {
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start' as const, id: 'final' },
            { type: 'text-delta' as const, id: 'final', delta: '任务完成' },
            { type: 'text-end' as const, id: 'final' },
            {
              type: 'finish' as const,
              finishReason: { unified: 'stop' as const, raw: undefined },
              usage: usage(),
            },
          ],
        }),
      },
    ],
  })
}

function loopingModel(count: number, identical: boolean): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: toolStreams(count, identical) })
}

function toolStreams(count: number, identical: boolean) {
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
          usage: usage(),
        },
      ],
    }),
  }))
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

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
