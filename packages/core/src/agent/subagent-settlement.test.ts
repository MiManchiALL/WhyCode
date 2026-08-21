import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import type { SubagentSettlementNotification } from '../subagents/types.ts'
import { AgentSession } from './session.ts'

describe('子代理终态续轮', () => {
  it('空闲父会话由宿主消息自动续轮，并在交接提交后确认 delivered', async () => {
    const events: CoreEvent[] = []
    let delivered = false
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        const prompt = JSON.stringify(options.prompt)
        assert.match(prompt, /subagent-settlement/)
        assert.match(prompt, /已确认两个调用点/)
        return finalStep('已结合子代理结果完成父任务。')
      },
    })
    const session = createSession(model, events)

    assert.equal(
      await session.handleSubagentSettlement(notification(), () => { delivered = true }),
      'completed',
    )
    assert.equal(delivered, true)
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(events.some((event) => event.type === 'message-queued'), false)
    assert.equal(events.some((event) => event.type === 'message-injected'), false)
  })

  it('父会话正在工作时在稳定步骤边界接入，不要求子代理主动汇报', async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    let call = 0
    let delivered = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call++
        if (call === 1) {
          started.resolve()
          await release.promise
          return finalStep('父任务第一阶段。')
        }
        assert.match(JSON.stringify(options.prompt), /subagent-settlement/)
        return finalStep('父任务已消费子代理终态。')
      },
    })
    const session = createSession(model, [])
    const running = session.handleUserMessage('开始父任务')
    await started.promise

    assert.equal(
      session.handleSubagentSettlement(notification(), () => { delivered++ }),
      undefined,
    )
    release.resolve()

    assert.equal(await running, 'completed')
    assert.equal(call, 2)
    assert.equal(delivered, 1)
  })
})

function notification(): SubagentSettlementNotification {
  return {
    parentSessionId: '11111111-1111-4111-8111-111111111111',
    subagentId: '22222222-2222-4222-8222-222222222222',
    activationId: '33333333-3333-4333-8333-333333333333',
    name: '探索代理',
    outcome: 'completed',
    resultText: '已确认两个调用点。',
  }
}

function createSession(model: MockLanguageModelV4, events: CoreEvent[]): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
  })
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:subagent-settlement',
    displayName: 'Subagent Settlement Mock',
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
