import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APICallError, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { createCompactSummaryMessage, parseCompactSummaryMessage } from '../prompts/compact.ts'
import { createTurnAbortedMessage } from '../session/interruption.ts'
import { compactMessages, type CompactOptions } from './compact.ts'
import { compactTailBudget, estimateMessagesTokens } from './tokens.ts'
import { userTurn, withUserTurn } from './user-turn.ts'

const capabilities = { contextWindow: 128_000, maxOutput: 20_000 }
const root = (id: string) => withUserTurn({ role: 'user', content: `任务 ${id}` }, id, true)
const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text })
const oldSummary = (history: string | null, prefix: string | null = null, turnId: string | null = null) =>
  createCompactSummaryMessage({ historySummary: history, turnPrefixSummary: prefix, turnId })
const tail = assistant('原始尾部：' + 't'.repeat(75_000))

describe('摘要 PTL 扩大原样保留尾部', () => {
  it('手动首次全量；PTL 后保留多工具批次和中断边界，旧 H/P 仍参与摘要', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 1) throw overflow(2000)
      return response(calls === 2 ? '更新历史' : 'B 前缀')
    } })
    const batch = toolBatch(['left', 'right'], 12_000)
    const stop = createTurnAbortedMessage()
    const messages = [oldSummary('旧 H'), root('A'), oldSummary(null, '旧 P_A', 'A'), assistant('A 完成'),
      root('B'), assistant('B 早期工作'), ...batch, stop]
    const before = structuredClone(messages)
    const output = await compact(model, messages, { mode: 'manual' })
    assert.equal(calls, 3)
    for (const text of ['旧 H', '旧 P_A', 'left', 'right']) assert.ok(prompt(model, 0).includes(text))
    assert.match(prompt(model, 1), /旧 H/)
    assert.match(prompt(model, 1), /旧 P_A/)
    assert.match(prompt(model, 1), /A 完成/)
    assert.doesNotMatch(prompt(model, 1), /B 早期工作|left|right/)
    assert.match(prompt(model, 2), /任务 B/)
    assert.match(prompt(model, 2), /B 早期工作/)
    assert.doesNotMatch(prompt(model, 2), /left|right/)
    assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.historySummary, '更新历史')
    assert.equal(output.messages[1]!.content, '任务 B')
    assert.equal(parseCompactSummaryMessage(output.messages[2]!)?.turnPrefixSummary, 'B 前缀')
    assert.deepEqual(output.messages.slice(3), [...batch, stop])
    assert.deepEqual(messages, before)
    assert.doesNotMatch(output.summaryText, /历史.*缺失|未能保留/)
  })

  it('H 超限前退切点时，将后续任务整体移入尾部，取消原来的 P', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 1) throw overflow(2000)
      return response('新 H')
    } })
    const batch = toolBatch(['A-last'], 12_000)
    const latest = root('B')
    const messages = [oldSummary('H1'), root('A'), oldSummary(null, 'P_A', 'A'), assistant('A 早期'),
      ...batch, latest, assistant('B 新工作'), tail]
    const output = await compact(model, messages)
    assert.equal(calls, 2)
    assert.match(prompt(model, 1), /H1/)
    assert.match(prompt(model, 1), /P_A/)
    assert.match(prompt(model, 1), /A 早期/)
    assert.doesNotMatch(prompt(model, 1), /A-last|任务 B|B 新工作|原始尾部/)
    assert.deepEqual(output.messages.slice(1), [...batch, latest, messages.at(-2), tail])
    assert.equal(output.messages.map(parseCompactSummaryMessage).some(state => state?.turnPrefixSummary), false)
  })

  it('P 超限时复用输入未变的 H，保留 B 原文一次且不把尾部送入摘要', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      calls++
      if (calls === 2) throw overflow(2000)
      return response(calls === 1 ? 'H2' : 'P_B')
    } })
    const batch = toolBatch(['B-new'], 12_000)
    const messages = [oldSummary('H1'), root('A'), oldSummary(null, 'P_A', 'A'), assistant('A 完成'),
      root('B'), assistant('B 前期'), ...batch, tail]
    const output = await compact(model, messages)
    assert.equal(calls, 3, 'H 成功后不因 P 退避重复请求')
    assert.doesNotMatch(prompt(model, 2), /H1|P_A|A 完成|B-new|原始尾部/)
    assert.match(prompt(model, 2), /任务 B|B 前期/)
    assert.deepEqual(output.messages.slice(3), [...batch, tail])
    assert.equal(output.messages.filter(message => userTurn(message)?.startsTurn).length, 1)
    assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.historySummary, 'H2')
  })

  it('同一正式 turn 的旧前缀不会被 PTL 丢弃，H 继续原样携带', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 1) throw overflow(2000)
      return response('P_A2')
    } })
    const batch = toolBatch(['A-new'], 12_000)
    const messages = [oldSummary('H1'), root('A'), oldSummary(null, 'P_A1', 'A'), assistant('A 早期'), ...batch, tail]
    const output = await compact(model, messages)
    assert.equal(calls, 2)
    assert.match(prompt(model, 1), /whycode-previous-turn-prefix-summary/)
    assert.match(prompt(model, 1), /P_A1/)
    assert.match(prompt(model, 1), /任务 A|A 早期/)
    assert.doesNotMatch(prompt(model, 1), /H1|A-new|原始尾部/)
    assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.historySummary, 'H1')
    assert.equal(parseCompactSummaryMessage(output.messages[2]!)?.turnId, 'A')
    assert.deepEqual(output.messages.slice(3), [...batch, tail])
  })

  it('P 的唯一工作批次退入尾部后省略空 P，直接采用已经完成的 H', async () => {
    let calls = 0
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 2) throw overflow(2000)
      return response('已完成 H')
    } })
    const latest = root('B')
    const batch = toolBatch(['B-prefix'], 12_000)
    const messages = [oldSummary('H1'), root('A'), assistant('A 结果'), latest, ...batch, tail]
    const output = await compact(model, messages)
    assert.equal(calls, 2, 'P 超限后既不再请求空 P，也不重新请求输入未变的 H')
    assert.equal(output.summaryText, '已完成 H')
    assert.deepEqual(output.messages.slice(1), [latest, ...batch, tail])
  })

  for (const gap of [2000, 20_000]) {
    it(`PTL 差额 ${gap} 退到 U 或其后首批次时，将旧 P 合入 H`, async () => {
      let calls = 0
      const model = new MockLanguageModelV4({ doGenerate: async () => {
        calls++
        if (calls === 2) throw overflow(gap)
        return response(calls === 1 ? '原范围 H' : '重新合并 H')
      } })
      const latest = root('B')
      const batch = toolBatch(['B-prefix'], 12_000)
      const messages = [oldSummary('H1'), root('A'), assistant('A 结果'), latest,
        oldSummary(null, 'P_B1', 'B'), ...batch, tail]
      const output = await compact(model, messages)
      assert.equal(calls, 3)
      assert.doesNotMatch(prompt(model, 0), /P_B1/)
      assert.match(prompt(model, 2), /whycode-completed-turn-prefix-summary/)
      assert.match(prompt(model, 2), /P_B1/)
      assert.doesNotMatch(prompt(model, 2), /任务 B|B-prefix|原始尾部/)
      assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.historySummary, '重新合并 H')
      assert.deepEqual(output.messages.slice(1), [latest, ...batch, tail])
    })
  }

  it('无 token 差额以 16% 尾部预算退避，仍超限时共用最多 3 次额度', async () => {
    const retries: number[] = []
    const messages = [oldSummary('累计 H'), ...Array.from({ length: 20 }, (_, i) =>
      [root(`T${i}`), assistant(`记录 ${i}:` + 'x'.repeat(25_000))]).flat()]
    const before = structuredClone(messages)
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw overflow() } })
    await assert.rejects(compact(model, messages, { mode: 'manual', onRetry: event => retries.push(event.retry) }), /prompt is too long/)
    assert.equal(model.doGenerateCalls.length, 4)
    assert.deepEqual(retries, [1, 2, 3])
    for (let index = 1; index < 4; index++) {
      const previous = model.doGenerateCalls[index - 1]!.prompt
      const next = model.doGenerateCalls[index]!.prompt
      assert.ok(estimateMessagesTokens(previous) - estimateMessagesTokens(next) >= compactTailBudget(capabilities))
      assert.match(prompt(model, index), /累计 H/)
    }
    assert.deepEqual(messages, before)
  })

  it('手动 H 转 P 后重试额度不重置，H 成功也不能提前采纳', async () => {
    let calls = 0
    const retries: number[] = []
    const messages = [root('A'), assistant('A 完成'), root('B'),
      ...Array.from({ length: 6 }, (_, i) => assistant(`B 步骤 ${i}:` + 'x'.repeat(4000)))]
    const before = structuredClone(messages)
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 2) return response('本次未提交 H')
      throw overflow(100)
    } })
    await assert.rejects(compact(model, messages, { mode: 'manual', onRetry: event => retries.push(event.retry) }), /prompt is too long/)
    assert.equal(calls, 5, '一次 H 成功与四次超限，共三次 PTL 退避')
    assert.deepEqual(retries, [1, 2, 3])
    assert.deepEqual(messages, before)
  })

  it('只剩旧摘要或不可拆的工具批次时失败，不丢弃摘要或拆开批次', async () => {
    for (const messages of [[oldSummary('只有 H', '只有 P', 'A')],
      [root('A'), ...toolBatch(['indivisible'], 12_000)]]) {
      const before = structuredClone(messages)
      const model = new MockLanguageModelV4({ doGenerate: async () => { throw overflow() } })
      await assert.rejects(compact(model, messages, { mode: 'manual' }), /prompt is too long/)
      assert.equal(model.doGenerateCalls.length, 1)
      assert.deepEqual(messages, before)
    }
  })

  it('退避期间取消或收到迟到摘要，均不再请求或改写原上下文', async () => {
    const messages = [root('A'), assistant('前期记录'), ...toolBatch(['new'], 12_000)]
    const before = structuredClone(messages)
    const abort = new AbortController()
    const model = new MockLanguageModelV4({ doGenerate: async () => { throw overflow(100) } })
    await assert.rejects(compact(model, messages, { mode: 'manual', abortSignal: abort.signal,
      onRetry: () => abort.abort() }))
    assert.equal(model.doGenerateCalls.length, 1)
    const lateAbort = new AbortController()
    const late = new MockLanguageModelV4({ doGenerate: async () => { lateAbort.abort(); return response('迟到摘要') } })
    await assert.rejects(compact(late, messages, { mode: 'manual', abortSignal: lateAbort.signal }))
    assert.deepEqual(messages, before)

    const cachedAbort = new AbortController()
    let calls = 0
    const cached = new MockLanguageModelV4({ doGenerate: async () => {
      if (++calls === 2) throw overflow(100)
      return response('已完成但未采纳的 H')
    } })
    const onlyStep = [root('old'), assistant('旧任务完成'), root('A'), ...toolBatch(['only'], 12_000), tail]
    const original = structuredClone(onlyStep)
    await assert.rejects(compact(cached, onlyStep, { abortSignal: cachedAbort.signal,
      onRetry: () => cachedAbort.abort() }), { name: 'AbortError' })
    assert.equal(calls, 2, '取消后即使只需复用 H、没有新的摘要请求，也不能返回候选')
    assert.deepEqual(onlyStep, original)
  })
})

function compact(model: MockLanguageModelV4, messages: ModelMessage[], options: Partial<CompactOptions> = {}) {
  return compactMessages({ model, messages, capabilities, abortSignal: new AbortController().signal, mode: 'auto', ...options })
}
function prompt(model: MockLanguageModelV4, index: number): string {
  return JSON.stringify(model.doGenerateCalls[index]!.prompt)
}
function response(text: string) {
  return { content: [{ type: 'text' as const, text: `<summary>${text}</summary>` }],
    finishReason: { unified: 'stop' as const, raw: undefined }, warnings: [],
    usage: { inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined } } }
}
function overflow(gap?: number) {
  return new APICallError({ message: gap === undefined ? 'prompt is too long'
    : `prompt is too long: ${128_000 + gap} tokens > 128000 maximum`,
    statusCode: 400, url: 'http://localhost/model', requestBodyValues: {} })
}
function toolBatch(ids: string[], size: number): ModelMessage[] {
  return [
    { role: 'assistant', content: ids.map(id => ({ type: 'tool-call', toolCallId: id, toolName: 'ReadFile', input: { path: `${id}.txt` } })) },
    ...ids.map((id): ModelMessage => ({ role: 'tool', content: [
      { type: 'tool-result', toolCallId: id, toolName: 'ReadFile', output: { type: 'text', value: `${id}:` + 'x'.repeat(size) } },
    ] })),
    { role: 'user', content: '批次完成通知' },
  ]
}
