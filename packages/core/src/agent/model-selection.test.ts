import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('运行中模型选择', () => {
  it('当前 turn 固化原模型，运行中选择的新模型从下一 turn 生效', async () => {
    const events: CoreEvent[] = []
    const nextModel = new MockLanguageModelV4({
      doStream: [textStep('下一回合')],
    })
    const nextEntry = modelEntry('test:next-model', nextModel, 200_000)
    let session!: AgentSession
    const switchModel = buildTool({
      name: 'SwitchModelProbe',
      description: '在模型步骤之间切换会话默认模型',
      prompt: '调用模型切换探针',
      inputSchema: z.object({}),
      isReadOnly: true,
      kind: 'control',
      async execute() {
        await session.setModelSelection(nextEntry, { apiKey: 'next' }, 'default')
        return { data: 'switched', isError: false }
      },
    })
    const currentModel = new MockLanguageModelV4({
      doStream: [toolStep('SwitchModelProbe'), textStep('当前回合')],
    })
    session = new AgentSession({
      model: modelEntry('test:current-model', currentModel),
      providerConfig: { apiKey: 'current' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([switchModel])

    assert.equal(await session.handleUserMessage('开始'), 'completed')
    assert.equal(currentModel.doStreamCalls.length, 2)
    assert.equal(nextModel.doStreamCalls.length, 0)
    const switchedUsage = events.filter((event) => event.type === 'context-usage').at(-1)
    assert.equal(
      switchedUsage?.type === 'context-usage' && switchedUsage.usage?.contextWindow,
      200_000,
    )

    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(currentModel.doStreamCalls.length, 2)
    assert.equal(nextModel.doStreamCalls.length, 1)
  })
})

function toolStep(toolName: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'switch-model',
          toolName,
          input: '{}',
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

function textStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: text },
        { type: 'text-end' as const, id: 'answer' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function modelEntry(
  id: string,
  model: MockLanguageModelV4,
  contextWindow = 100_000,
): ModelEntry {
  return {
    id,
    displayName: id,
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow,
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
