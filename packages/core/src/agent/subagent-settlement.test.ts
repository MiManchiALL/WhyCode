import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import type {
  SubagentSettlementNotification,
  SubagentTurnState,
} from '../subagents/types.ts'
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

  it('同一 turn 逐个接收终态、允许用户插话，并等待全部交付后才结束', async () => {
    const events: CoreEvent[] = []
    const calls = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()]
    const delivered = new Set<string>()
    let parentTurnId = ''
    let ended = false
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        const index = call++
        const prompt = JSON.stringify(options.prompt)
        calls[index]?.resolve()
        if (index === 0) {
          assert.match(prompt, /whycode-subagent-turn-state/)
          assert.match(prompt, /\\"remaining\\":2/)
          return finalStep('本地检查已经完成，继续等待子代理。')
        }
        if (index === 1) {
          assert.match(prompt, /补充检查边界条件/)
          assert.match(prompt, /\\"remaining\\":2/)
          return finalStep('已处理补充要求，仍在等待子代理。')
        }
        if (index === 2) {
          assert.match(prompt, /第一个结果/)
          assert.match(prompt, /\\"remaining\\":1/)
          return finalStep('第一个子代理已完成，我继续等待另一个。')
        }
        assert.match(prompt, /第二个结果/)
        assert.match(prompt, /只表示子代理等待条件已满足/)
        assert.match(prompt, /\\"remaining\\":0/)
        return finalStep('两个子代理均已完成，这是综合结论。')
      },
    })
    const session = createSession(model, events, async (turnId) => {
      parentTurnId = turnId
      return turnState(turnId, delivered)
    })
    const running = session.handleUserMessage('并行调查两个方向')!
    void running.then(() => { ended = true })

    await calls[0]!.promise
    await eventLoopTurn()
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(ended, false)

    assert.equal(session.handleUserMessage('补充检查边界条件'), undefined)
    await calls[1]!.promise
    await eventLoopTurn()
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(ended, false)

    session.handleSubagentSettlement(
      notificationFor(parentTurnId, FIRST_ACTIVATION_ID, '第一个结果'),
      () => { delivered.add(FIRST_ACTIVATION_ID) },
    )
    await calls[2]!.promise
    await eventLoopTurn()
    assert.equal(model.doStreamCalls.length, 3)
    assert.equal(ended, false)

    session.handleSubagentSettlement(
      notificationFor(parentTurnId, SECOND_ACTIVATION_ID, '第二个结果'),
      () => { delivered.add(SECOND_ACTIVATION_ID) },
    )
    await calls[3]!.promise
    assert.equal(await running, 'completed')
    assert.equal(model.doStreamCalls.length, 4)
    assert.equal(events.filter((event) => event.type === 'turn-start').length, 1)
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 1)
  })

  it('等待子代理期间 Stop 直接结束，不额外发起模型请求', async () => {
    const started = deferred<void>()
    const model = new MockLanguageModelV4({
      doStream: async () => {
        started.resolve()
        return finalStep('本地工作已完成，等待子代理。')
      },
    })
    const session = createSession(model, [], async (turnId) => ({
      parentTurnId: turnId,
      activations: [turnActivation(
        FIRST_SUBAGENT_ID,
        FIRST_ACTIVATION_ID,
        1,
        new Set<string>(),
      )],
    }))
    const running = session.handleUserMessage('开始父任务')!
    await started.promise
    await eventLoopTurn()

    session.abort()
    assert.equal(await running, 'aborted')
    assert.equal(model.doStreamCalls.length, 1)
  })
})

const FIRST_SUBAGENT_ID = '22222222-2222-4222-8222-222222222222'
const SECOND_SUBAGENT_ID = '44444444-4444-4444-8444-444444444444'
const FIRST_ACTIVATION_ID = '33333333-3333-4333-8333-333333333333'
const SECOND_ACTIVATION_ID = '55555555-5555-4555-8555-555555555555'

function notification(): SubagentSettlementNotification {
  return {
    parentSessionId: '11111111-1111-4111-8111-111111111111',
    parentTurnId: 'parent-turn-1',
    subagentId: '22222222-2222-4222-8222-222222222222',
    activationId: '33333333-3333-4333-8333-333333333333',
    name: '探索代理',
    outcome: 'completed',
    resultText: '已确认两个调用点。',
  }
}

function notificationFor(
  parentTurnId: string,
  activationId: string,
  resultText: string,
): SubagentSettlementNotification {
  return {
    parentSessionId: '11111111-1111-4111-8111-111111111111',
    parentTurnId,
    subagentId: activationId === FIRST_ACTIVATION_ID
      ? FIRST_SUBAGENT_ID
      : SECOND_SUBAGENT_ID,
    activationId,
    name: '探索代理',
    outcome: 'completed',
    resultText,
  }
}

function turnState(parentTurnId: string, delivered: ReadonlySet<string>): SubagentTurnState {
  return {
    parentTurnId,
    activations: [
      turnActivation(FIRST_SUBAGENT_ID, FIRST_ACTIVATION_ID, 1, delivered),
      turnActivation(SECOND_SUBAGENT_ID, SECOND_ACTIVATION_ID, 1, delivered),
    ],
  }
}

function turnActivation(
  subagentId: string,
  activationId: string,
  sequence: number,
  delivered: ReadonlySet<string>,
): SubagentTurnState['activations'][number] {
  return {
    subagentId,
    activationId,
    name: '探索代理',
    sequence,
    ...(delivered.has(activationId)
      ? { outcome: 'completed' as const, settlement: 'delivered' as const }
      : {}),
  }
}

function createSession(
  model: MockLanguageModelV4,
  events: CoreEvent[],
  getSubagentTurnState?: (turnId: string) => Promise<SubagentTurnState>,
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    ...(getSubagentTurnState ? { getSubagentTurnState } : {}),
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

function eventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
