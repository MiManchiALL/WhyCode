import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { tool, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { createTurnAbortedMessage, createTurnAbortedConsumedMessage } from '../session/interruption.ts'
import { createUserQuestionMarker } from '../tasks/answer-resume.ts'
import { createCompactApplicationContextMessage, createCompactSummaryMessage, parseCompactSummaryMessage } from '../prompts/compact.ts'
import { compactMessages, type CompactOptions } from './compact.ts'
import { prepareCompaction, pickBudgetStart } from './compact-boundary.ts'
import { compactTailBudget } from './tokens.ts'
import { userTurn, withUserTurn } from './user-turn.ts'
import { compactionConversation } from './compact-context.ts'

const capabilities = { contextWindow: 128_000, maxOutput: 20_000 }
const tail = { role: 'assistant' as const, content: 'TAIL_ONLY_' + 'x'.repeat(75_000) }
const assistant = (content: string): ModelMessage => ({ role: 'assistant', content })
const root = (id: string, content = id): ModelMessage => withUserTurn({ role: 'user', content }, id, true)
const state = (historySummary: string | null, turnPrefixSummary: string | null = null, turnId: string | null = null) =>
  createCompactSummaryMessage({ historySummary, turnPrefixSummary, turnId })

describe('按预算划分历史与当前正式 turn', () => {
  it('尾部为可用输入预算的 16%，不受工具次数影响', () => {
    assert.equal(compactTailBudget(capabilities), 17_280)
    assert.equal(compactTailBudget({ contextWindow: 200_000, maxOutput: 64_000 }), 28_800)
    const messages = [root('A'), assistant('进展'), tail]
    assert.equal(pickBudgetStart(messages, compactTailBudget(capabilities)), 2)
    assert.deepEqual(prepareCompaction(messages, 17_280)?.tail, [tail])
  })

  it('切点不能拆开多工具批次，即使调用和结果之间插有通知', () => {
    const call: ModelMessage = { role: 'assistant', content: ['a', 'b'].map(id => ({
      type: 'tool-call', toolCallId: id, toolName: 'ReadFile', input: { path: `${id}.txt` },
    })) }
    const messages = [root('A'), assistant('早期'), call, result('a', '内容'),
      { role: 'user' as const, content: '<system-reminder>工具等待</system-reminder>' },
      result('b', 'x'.repeat(75_000)), assistant('结束')]
    assert.equal(pickBudgetStart(messages, 17_280), 2)
    assert.deepEqual(prepareCompaction(messages, 17_280)?.tail, messages.slice(2))
  })

  it('B 在尾部中时只压缩旧历史，即使切点位于 A 的回复中', () => {
    const messages = [root('A'), assistant('旧记录'), tail, root('B'), assistant('刚开始 B')]
    const prepared = prepareCompaction(messages, 17_280)!
    assert.equal(prepared.turnPrefixSource, null)
    assert.equal(prepared.pinnedUser, null)
    assert.deepEqual(prepared.historySource?.messages, messages.slice(0, 2))
  })

  it('切点紧随 U 时把 U 一并留在尾部，不为没有工作记录的前缀请求 P', async () => {
    for (const previousPrefix of [null, '旧 P_B']) {
      const latest = root('B', '完整任务 B')
      const batch = [call('B-first', 'ReadFile', { path: 'example.pdf' }), result('B-first', 'x'.repeat(75_000))]
      const messages = [state('H1'), root('A'), assistant('A 已完成'), latest,
        ...(previousPrefix ? [state(null, previousPrefix, 'B')] : []), ...batch]
      const model = summaryModel(['新 H'])
      const output = await compact(model, messages)
      assert.equal(model.doGenerateCalls.length, 1)
      const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
      assert.match(prompt, /H1/)
      assert.match(prompt, /A 已完成/)
      assert.doesNotMatch(prompt, /完整任务 B|B-first/)
      if (previousPrefix) {
        assert.match(prompt, /whycode-completed-turn-prefix-summary/)
        assert.match(prompt, /旧 P_B/)
      }
      assert.equal(output.summaryText, '新 H')
      assert.deepEqual(output.messages.slice(1), [latest, ...batch])
    }
  })

  it('尾部插话不替代正式用户起点；B 原文完整保留一次', async () => {
    const b = root('B', '严格保留的原始请求')
    const steering = withUserTurn({ role: 'user', content: '补充：先检查取消路径' }, 'B', false)
    const input = [root('A'), assistant('A 完成'), b, assistant('B 早期记录'), tail, steering]
    const model = summaryModel(['历史 A', 'B 前缀'])
    const output = await compact(model, input)
    assert.equal(model.doGenerateCalls.length, 2)
    assert.equal(output.messages.filter(message => userTurn(message)?.startsTurn && userTurn(message)?.id === 'B').length, 1)
    assert.equal(output.messages[1]?.content, b.content)
    assert.equal(parseCompactSummaryMessage(output.messages[2]!)?.turnId, 'B')
    assert.deepEqual(output.messages.slice(3), [tail, steering])
    assert.doesNotMatch(JSON.stringify(model.doGenerateCalls), /TAIL_ONLY_|补充：先检查取消路径/)
    assert.doesNotMatch(JSON.stringify(model.doGenerateCalls[0]!.prompt), /B 早期记录|严格保留的原始请求/)
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /严格保留的原始请求|B 早期记录/)
  })

  it('同一 turn 多次压缩只更新前缀，已有摘要不占尾部切点', async () => {
    const model = summaryModel(['P_A2'])
    const h = state('H1')
    const messages = [h, root('A'), state(null, 'P_A1', 'A'), assistant('新增记录'), tail]
    const output = await compact(model, messages)
    assert.equal(model.doGenerateCalls.length, 1)
    assert.match(JSON.stringify(model.doGenerateCalls[0]!.prompt), /P_A1|新增记录/)
    assert.doesNotMatch(JSON.stringify(model.doGenerateCalls[0]!.prompt), /H1|TAIL_ONLY_/)
    assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.historySummary, 'H1')
    assert.equal(parseCompactSummaryMessage(output.messages[2]!)?.turnPrefixSummary, 'P_A2')
    assert.equal(output.messages.at(-1), tail)
  })

  it('切入 B 时旧 H 与 P_A 一起归入历史，P_B 从 B 新建', async () => {
    const model = summaryModel(['H2', 'P_B'])
    const messages = [state('H1'), root('A'), state(null, 'P_A', 'A'), assistant('A 后续结果'),
      root('B'), assistant('B 新工作'), tail]
    const output = await compact(model, messages)
    const h = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    const p = JSON.stringify(model.doGenerateCalls[1]!.prompt)
    assert.match(h, /H1/); assert.match(h, /P_A/); assert.match(h, /A 后续结果/)
    assert.doesNotMatch(h, /B 新工作/)
    assert.match(p, /B 新工作/); assert.doesNotMatch(p, /P_A|H1|A 后续结果/)
    assert.equal(parseCompactSummaryMessage(output.messages[2]!)?.turnId, 'B')
  })

  it('仅有巨大旧摘要或原始请求时不循环重压摘要，不切进摘要文本', async () => {
    const model = summaryModel([])
    for (const messages of [[state('x'.repeat(120_000)), root('A'), assistant('短尾部')], [root('A'), tail],
      [state('H1'), root('A'), state(null, 'P_A1', 'A'), tail]]) {
      const output = await compact(model, messages)
      assert.equal(output.summaryText, '')
      assert.deepEqual(output.messages, messages)
    }
    assert.equal(model.doGenerateCalls.length, 0)
  })

  it('自动压缩保留未消费中断、完整问题与最新输入；消费标记解除边界', () => {
    const stop = createTurnAbortedMessage()
    const question = createUserQuestionMarker({ id: 'q', questions: [{ header: '选择', question: '选择方案？',
      options: [{ label: 'A', description: '方案 A' }, { label: 'B', description: '方案 B' }] }] }, true)
    for (const marker of [stop, question]) {
      const messages = [root('A'), assistant('早期'), tail, marker, root('B')]
      const kept = prepareCompaction(messages, 17_280)!.tail
      assert.ok(kept.includes(marker)); assert.ok(kept.includes(messages.at(-1)!))
    }
    const messages = [root('A'), stop, root('B'), assistant('意图已确认'), createTurnAbortedConsumedMessage(), tail]
    assert.deepEqual(prepareCompaction(messages, 17_280)?.tail, [tail])
  })
})

describe('全量摘要输入与手动压缩', () => {
  it('手动压缩短历史也调用模型，不剪枝、不保留尾部或固定旧用户消息', async () => {
    const model = summaryModel(['所有阶段摘要'])
    const messages = [root('A'), call('r', 'ReadFile', { path: 'file.txt' }), result('r', 'LONG_TEXT_' + 'x'.repeat(9000)), assistant('完成')]
    const output = await compact(model, messages, { mode: 'manual' })
    assert.equal(model.doGenerateCalls.length, 1)
    assert.match(JSON.stringify(model.doGenerateCalls[0]!.prompt), /LONG_TEXT_/)
    assert.ok(JSON.stringify(model.doGenerateCalls[0]!.prompt).includes('x'.repeat(9000)))
    assert.equal(output.messages.length, 1)
    assert.equal(userTurn(output.messages[0]!), undefined)
    assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.turnPrefixSummary, null)
  })

  it('手动压缩重新生成完整旧 H/P，同时精确保留尚有效的控制边界', async () => {
    const model = summaryModel(['整合历史'])
    const marker = createTurnAbortedMessage()
    const output = await compact(model, [state('H'), root('A'), state(null, 'P_A', 'A'), assistant('工作'), marker], { mode: 'manual' })
    assert.equal(model.doGenerateCalls.length, 1)
    assert.match(JSON.stringify(model.doGenerateCalls[0]!.prompt), /P_A/)
    assert.deepEqual(output.messages.slice(1), [marker])
  })

  it('剥离可重建的规范、计划快照，但保留 Skill 独有资料、错误和操作结果', async () => {
    const messages: ModelMessage[] = [root('A'),
      createCompactApplicationContextMessage(['旧计划全文']),
      call('skill-body', 'Skill', { skillId: 'example' }), result('skill-body', 'SKILL_BODY_UNIQUE', 'Skill'),
      call('reference', 'Skill', { skillId: 'example', resourcePath: 'references/api-details.md' }),
      result('reference', '独有 API 参考资料', 'Skill'),
      call('failed', 'Skill', { skillId: 'missing' }),
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'failed', toolName: 'Skill', output: { type: 'error-text', value: '资源不存在' } }] },
      call('plan', 'UpdateTaskItem', { itemId: '1', status: 'completed' }),
      result('plan', '<whycode-task-result schema-version="1">\n{"ok":true,"message":"验证完成"}\n</whycode-task-result>\n<whycode-task-state schema-version="1">\n整份计划\n</whycode-task-state>', 'UpdateTaskItem'),
      assistant('阶段完成'),
    ]
    const model = summaryModel(['摘要'])
    await compact(model, messages, { mode: 'manual' })
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    assert.doesNotMatch(prompt, /旧计划全文|SKILL_BODY_UNIQUE|整份计划/)
    assert.match(prompt, /独有 API 参考资料/); assert.match(prompt, /资源不存在/); assert.match(prompt, /验证完成/)
    const quotedRule = root('B', '<system-reminder>\n<whycode-task-state schema-version="1">\n请修改此格式')
    assert.deepEqual(compactionConversation([quotedRule]), [quotedRule])
  })

  it('摘要返回工具调用时拒绝结果，不触发工具执行或输入回调', async () => {
    let executions = 0
    const tools = { Probe: tool({ description: '测试', inputSchema: z.object({}),
      onInputAvailable: async () => { executions++ }, execute: async () => { executions++; return 'bad' } }) }
    const model = new MockLanguageModelV4({ doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'bad', toolName: 'Probe', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
    }) })
    await assert.rejects(compact(model, [root('A'), assistant('工作')], { mode: 'manual', tools }), /试图调用工具/)
    assert.equal(executions, 0)
    assert.equal(model.doGenerateCalls[0]?.tools?.[0]?.type, 'function')
    assert.equal(model.doGenerateCalls[0]?.maxOutputTokens, 5760)
  })

  it('空摘要、未闭合摘要和截断结果拒绝；第二份摘要失败不改写输入', async () => {
    for (const text of ['', '没有标签的摘要', '<summary>未闭合', '<summary> \n </summary>']) {
      const model = summaryModel([], text)
      await assert.rejects(compact(model, [root('A'), assistant('工作')], { mode: 'manual' }), /摘要为空或格式不完整/)
    }
    const truncated = new MockLanguageModelV4({ doGenerate: async () => ({ ...response('看似完整的部分结果'),
      finishReason: { unified: 'length', raw: undefined } }) })
    await assert.rejects(compact(truncated, [root('A'), assistant('工作')], { mode: 'manual' }), /摘要未正常完成/)
    const messages = [root('A'), assistant('A 结果'), root('B'), assistant('B 记录'), tail]
    const before = structuredClone(messages)
    await assert.rejects(compact(summaryModel(['历史', '']), messages))
    assert.deepEqual(messages, before)
  })

  it('只提取完整摘要，允许标签外的说明和代码围栏', async () => {
    for (const raw of ['以下是摘要：\n<summary> 有效摘要 </summary>\n已整理完毕。',
      '```xml\n<summary>有效摘要</summary>\n```']) {
      const output = await compact(summaryModel([], raw), [root('A'), assistant('工作')], { mode: 'manual' })
      assert.equal(output.summaryText, '有效摘要')
      assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.historySummary, '有效摘要')
    }
  })

  it('摘要正文引用结束标签时保留引用及其后的完整内容', async () => {
    for (const body of ['已修复 `<summary>...</summary>` 的提取逻辑。\n下一步：验证 PTL。',
      '结束标记是 `</summary>`。\n```xml\n<summary>示例</summary>\n```\n仍需保留的约束：禁止执行工具。']) {
      const raw = `以下是摘要：\n\`\`\`markdown\n<summary>\n${body}\n</summary>\n\`\`\`\n整理完毕。`
      const output = await compact(summaryModel([], raw), [root('A'), assistant('修改标签提取')], { mode: 'manual' })
      assert.equal(output.summaryText, body)
      assert.equal(parseCompactSummaryMessage(output.messages[0]!)?.historySummary, body)
    }
  })

  it('正常完成的摘要不再被字符估算拒绝，usage 缺省也不影响有效正文', async () => {
    const text = 'x'.repeat(24_000) // 本地估算 6000，超过本例请求预算 5760。
    for (const total of [4000, undefined]) {
      const model = new MockLanguageModelV4({ doGenerate: async () => ({ ...response(text),
        usage: { ...usage, outputTokens: { total, text: total, reasoning: undefined } },
      }) })
      const output = await compact(model, [root('A'), assistant('工作')], { mode: 'manual' })
      assert.equal(model.doGenerateCalls[0]!.maxOutputTokens, 5760)
      assert.equal(output.summaryText, text)
    }
  })
})

function compact(model: MockLanguageModelV4, messages: ModelMessage[], options: Partial<CompactOptions> = {}) {
  return compactMessages({ model, messages, capabilities, abortSignal: new AbortController().signal, mode: 'auto', ...options })
}
function summaryModel(outputs: string[], raw?: string) {
  let index = 0
  return new MockLanguageModelV4({ doGenerate: async () => response(outputs[index++] ?? '', raw) })
}
function response(text: string, raw?: string) {
  return { content: [{ type: 'text' as const, text: raw ?? `<summary>${text}</summary>` }],
    finishReason: { unified: 'stop' as const, raw: undefined }, usage, warnings: [] }
}
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined } }
function call(id: string, toolName: string, input: unknown): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName, input }] }
}
function result(id: string, value: string, toolName = 'ReadFile'): ModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName, output: { type: 'text', value } }] }
}
