import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('Agent 工具循环安全上限', () => {
  it('接近上限时要求收尾，耗尽后明确停止并返回原因', async () => {
    const model = loopingModel(45)
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([probeTool])

    const stopReason = await session.handleUserMessage('持续调用工具')

    assert.equal(stopReason, 'max-turns')
    assert.equal(model.doStreamCalls.length, 40)
    assert.equal(
      events.some(
        (event) =>
          event.type === 'error' &&
          event.message.includes('40 步工具循环安全上限') &&
          event.recoverable,
      ),
      true,
    )
    assert.match(JSON.stringify(model.doStreamCalls.at(-1)), /接近工具循环安全上限|还剩 6 次模型请求/)
  })
})

const probeTool = buildTool({
  name: 'Probe',
  description: '测试工具',
  prompt: '执行测试探针',
  inputSchema: z.object({}),
  isReadOnly: true,
  kind: 'read',
  availableWithoutProject: true,
  async execute() {
    return { data: 'ok', isError: false }
  },
})

function loopingModel(count: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: Array.from({ length: count }, (_, index) => ({
      stream: simulateReadableStream({
        chunks: [
          {
            type: 'tool-call' as const,
            toolCallId: `probe-${index}`,
            toolName: 'Probe',
            input: '{}',
          },
          {
            type: 'finish' as const,
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
          },
        ],
      }),
    })),
  })
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:looping',
    displayName: 'Looping Mock',
    provider: 'openai',
    capabilities: {
      supportsNativeTools: true,
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
