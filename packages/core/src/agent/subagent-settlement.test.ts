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
import { AgentSession, type AgentSessionOptions } from './session.ts'
import { estimateMessageTokens, estimateTextTokens, compactTailBudget } from '../context/tokens.ts'
import { isSubagentSettlementText } from '../subagents/notification.ts'
import { ModelRequestError } from '../providers/model-request.ts'

describe('子代理终态续轮', () => {
  it('子代理结果已交付后父请求失败，重试与用户继续都保留结果且只确认一次交接', async () => {
    let requests = 0
    let delivered = 0
    const model = new MockLanguageModelV4({ doStream: async (options) => {
      assert.match(JSON.stringify(options.prompt), /已确认两个调用点/)
      if (++requests <= 4) throw new ModelRequestError('读取响应数据超时', true, 0)
      return finalStep('已使用保存的子代理结果继续。')
    } })
    const session = createSession(model, [], undefined, {
      pendingSubagentSettlements: async function* () { if (!delivered) yield notification() },
      onSubagentSettlementDelivered: async () => { delivered++ },
    })
    assert.equal(await session.handleUserMessage('处理已有结果'), 'error')
    assert.equal(delivered, 1)
    assert.equal(requests, 4)
    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(requests, 5)
    assert.equal(delivered, 1)
  })
  it('空闲和重启不发起模型请求，下一次用户输入才交付保存的结果', async () => {
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
    const session = createSession(model, events, undefined, {
      pendingSubagentSettlements: async function* () { if (!delivered) yield notification() },
      onSubagentSettlementDelivered: async () => { delivered = true },
    })

    assert.equal(
      await session.handleSubagentSettlement(notification(), () => { delivered = true }),
      undefined,
    )
    assert.equal(delivered, false)
    assert.equal(model.doStreamCalls.length, 0)
    assert.equal(await session.handleUserMessage('请总结已有结果'), 'completed')
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

  it('协商协议阶段保留待交付结果，恢复 Main 执行后正常接收', async () => {
    let delivered = 0
    let loads = 0
    const model = new MockLanguageModelV4({ doStream: async () => finalStep('阶段完成。') })
    const session = createSession(model, [], undefined, {
      pendingSubagentSettlements: async function* () { loads++; yield notification() },
      onSubagentSettlementDelivered: async () => { delivered++ },
    })
    session.setProtocolRound(true)
    session.handleSubagentSettlement(notification())
    assert.equal(await session.handleExecutionMessage('分析当前请求'), 'completed')
    assert.equal(loads, 0)
    assert.equal(delivered, 0)
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[0]!.prompt), /已确认两个调用点/)
    session.setProtocolRound(false)
    assert.equal(await session.handleExecutionMessage('执行当前请求'), 'completed')
    assert.equal(loads, 1)
    assert.equal(delivered, 1)
    assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), /已确认两个调用点/)
  })

  it('等待子代理时只响应立即插话与终态，普通输入在全部交付后另开回合', async (context) => {
    context.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 25, 10).getTime() })
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
        assert.equal(prompt.split('当前日期：').length - 1, 1)
        if (index === 4) {
          assert.match(prompt, /下一回合的独立问题/)
          return finalStep('已处理独立问题。')
        }
        assert.doesNotMatch(prompt, /下一回合的独立问题/)
        if (index === 0) {
          assert.match(prompt, /whycode-subagent-turn-state/)
          assert.match(prompt, /remaining 大于 0 时仍需等待结果交付/)
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
      if (parentTurnId && parentTurnId !== turnId) return { parentTurnId: turnId, activations: [] }
      parentTurnId = turnId
      return turnState(turnId, delivered)
    })
    const running = session.handleUserMessage('并行调查两个方向')!
    void running.then(() => { ended = true })

    await calls[0]!.promise
    await eventLoopTurn()
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(ended, false)

    session.handleUserMessage('下一回合的独立问题')
    await eventLoopTurn()
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(session.handleUserMessage('补充检查边界条件', true), undefined)
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
    assert.equal(model.doStreamCalls.length, 5)
    assert.equal(events.filter((event) => event.type === 'turn-start').length, 2)
    assert.equal(events.filter((event) => event.type === 'turn-end').length, 2)
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

  it('多个大结果分批交付并压缩历史，不把未消费的结果挤出窗口', async () => {
    const items = Array.from({ length: 8 }, (_, index) => ({
      ...notification(), activationId: crypto.randomUUID(), subagentId: crypto.randomUUID(),
      resultText: `结果${index}：` + '证据'.repeat(60_000),
    }))
    const delivered = new Set<string>()
    const observed = new Set<string>()
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: '<summary>已核实此前交付的调查结果。</summary>' }],
        finishReason: { unified: 'stop', raw: undefined }, warnings: [],
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 30, text: 30, reasoning: undefined } },
      }),
      doStream: async (options) => {
        const text = JSON.stringify(options.prompt)
        assert.ok(estimateTextTokens(text) < 100_000, '请求仍在父模型窗口内')
        const messages = options.prompt.flatMap(message => typeof message.content === 'string'
          ? [message.content] : message.content.flatMap(part => part.type === 'text' ? [part.text] : []))
        const fresh = messages.filter(isSubagentSettlementText).filter(content => !observed.has(content))
        assert.ok(fresh.length > 0)
        assert.ok(fresh.reduce((total, content) => total + estimateMessageTokens({ role: 'user', content }), 0)
          <= compactTailBudget(modelEntry(model).capabilities))
        for (const result of fresh) {
          assert.match(result, /后文已截断/)
          observed.add(result)
        }
        return finalStep('已核验本批结果。', estimateTextTokens(text))
      },
    })
    const session = createSession(model, [], undefined, {
      pendingSubagentSettlements: async function* () { yield* items },
      onSubagentSettlementDelivered: async item => { delivered.add(item.activationId) },
    })
    assert.equal(await session.handleUserMessage('汇总调查'), 'completed')
    assert.equal(delivered.size, items.length)
    assert.equal(observed.size, items.length)
    assert.ok(model.doGenerateCalls.length > 0, '旧历史确实进入自动压缩')
  })

  for (const reason of ['error', 'waiting-user'] as const) it(`父回合以 ${reason} 结束后不把预取结果带入协议回合`, async () => {
    const items = Array.from({ length: 3 }, (_, index) => ({
      ...notification(), activationId: crypto.randomUUID(), resultText: `历史调查 ${index}：` + '证据'.repeat(40_000),
    }))
    const delivered = new Set<string>()
    let firstTurn = true
    let asked = false
    const model = new MockLanguageModelV4({ doStream: async () => {
      if (!firstTurn) return finalStep('已处理。')
      if (reason === 'error') throw new Error('请求失败')
      if (asked) return finalStep('请确认调查范围。')
      asked = true
      return { stream: simulateReadableStream({ chunks: [
        { type: 'tool-call' as const, toolCallId: 'ask', toolName: 'AskUserQuestion', input: JSON.stringify({
          questions: [{ header: '调查范围', question: '核对哪个项目？', options: [
            { label: '甲', description: '核对项目甲' }, { label: '乙', description: '核对项目乙' },
          ] }],
        }) },
        { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: modelUsage() },
      ] }) }
    } })
    const session = createSession(model, [], undefined, {
      pendingSubagentSettlements: async function* () {
        const available = firstTurn && reason === 'waiting-user' ? items.slice(0, 1) : items
        for (const item of available) if (!delivered.has(item.activationId)) yield item
      },
      onSubagentSettlementDelivered: async item => { delivered.add(item.activationId) },
    })
    assert.equal(await session.handleUserMessage('处理调查'), reason)
    assert.equal(delivered.size, 1)
    firstTurn = false
    session.setProtocolRound(true)
    assert.equal(await session.handleExecutionMessage('讨论新请求'), 'completed')
    assert.equal(delivered.size, 1)
    session.setProtocolRound(false)
    const question = session.pendingQuestions[0]
    const replies = question ? [{ id: question.id, answer: '甲' }] : undefined
    assert.equal(await session.handleUserMessage('继续查看调查', false, [], undefined, [], [], 'native', replies), 'completed')
    assert.equal(delivered.size, 3)
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
    description: '核对调用链',
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
    description: '核对调用链',
    outcome: 'completed',
    resultText,
  }
}

function turnState(parentTurnId: string, delivered: ReadonlySet<string>): SubagentTurnState {
  return {
    parentTurnId,
    activations: [
      turnActivation(FIRST_SUBAGENT_ID, FIRST_ACTIVATION_ID, delivered),
      turnActivation(SECOND_SUBAGENT_ID, SECOND_ACTIVATION_ID, delivered),
    ],
  }
}

function turnActivation(
  subagentId: string,
  activationId: string,
  delivered: ReadonlySet<string>,
): SubagentTurnState['activations'][number] {
  return {
    subagentId,
    activationId,
    description: '核对调用链',
    ...(delivered.has(activationId)
      ? { outcome: 'completed' as const, settlement: 'delivered' as const }
      : {}),
  }
}

function createSession(
  model: MockLanguageModelV4,
  events: CoreEvent[],
  getSubagentTurnState?: (turnId: string) => Promise<SubagentTurnState>,
  options: Partial<AgentSessionOptions> = {},
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    ...(getSubagentTurnState ? { getSubagentTurnState } : {}),
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
    ...options,
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

function finalStep(text: string, inputTokens = 10) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: text },
        { type: 'text-end' as const, id: 'final' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: modelUsage(inputTokens),
        },
      ],
    }),
  }
}

function modelUsage(inputTokens = 10) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
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
