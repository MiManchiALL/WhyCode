import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { ModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('工具副作用串行', () => {
  it('同一步的非只读工具不会并发进入执行区', async () => {
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const probe = buildTool({
      name: 'SerialProbe',
      description: '串行探针',
      prompt: '执行串行探针',
      inputSchema: z.object({ value: z.number() }),
      isReadOnly: false,
      kind: 'control',
      availableWithoutProject: true,
      async execute({ value }) {
        active++
        maxActive = Math.max(maxActive, active)
        order.push(`start-${value}`)
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 40))
        order.push(`end-${value}`)
        active--
        return { data: `ok-${value}`, isError: false }
      },
    })
    const model = new MockLanguageModelV4({ doStream: [parallelToolStep(), finalStep()] })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([probe])

    await session.handleUserMessage('运行两个探针')

    assert.equal(maxActive, 1)
    assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2'])
  })
})

function parallelToolStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        toolCall('serial-1', 1),
        toolCall('serial-2', 2),
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function toolCall(id: string, value: number) {
  return {
    type: 'tool-call' as const,
    toolCallId: id,
    toolName: 'SerialProbe',
    input: JSON.stringify({ value }),
  }
}

function finalStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: '完成' },
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
    id: 'test:serial-tool',
    displayName: 'Serial Tool Mock',
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
