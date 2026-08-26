import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import type { BtwTurnContext, BtwTurnResult } from '../session/btw.ts'
import { AgentSession } from './session.ts'

describe('BTW 独立侧对话', () => {
  it('复用稳定 Main 背景但不装配工具，也不修改 Main 消息历史', async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        finalStep('主回答'),
        finalStep('第一轮侧回答'),
        finalStep('第二轮侧回答'),
      ],
    })
    const session = createSession(model)
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
      assistantText: '第一轮侧回答',
    }], first.conversationId, 2)
    const secondSettled: BtwTurnResult[] = []
    assert.equal(await session.handleBtwMessage(second, lifecycle(secondSettled)), 'completed')
    assert.equal(secondSettled[0]?.assistantText, '第二轮侧回答')
    assert.deepEqual(session.captureMessageSnapshot(), mainSnapshot)

    const firstSideCall = model.doStreamCalls[1]!
    const secondSideCall = model.doStreamCalls[2]!
    assert.deepEqual(firstSideCall.tools ?? [], [])
    assert.deepEqual(secondSideCall.tools ?? [], [])
    assert.match(JSON.stringify(firstSideCall.prompt), /主问题/)
    assert.match(JSON.stringify(firstSideCall.prompt), /主回答/)
    assert.match(JSON.stringify(firstSideCall.prompt), /第一轮侧问题/)
    assert.doesNotMatch(JSON.stringify(firstSideCall.prompt), /第一轮侧回答/)
    assert.match(JSON.stringify(secondSideCall.prompt), /第一轮侧问题/)
    assert.match(JSON.stringify(secondSideCall.prompt), /第一轮侧回答/)
    assert.match(JSON.stringify(secondSideCall.prompt), /第二轮侧问题/)
    assert.match(JSON.stringify(secondSideCall.prompt), /不要调用工具/)
  })
})

function createSession(model: MockLanguageModelV4): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
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
