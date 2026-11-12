import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { parseCompactSummaryMessage } from '../prompts/compact.ts'
import { recentPdfUserTurns, userTurn, withUserTurn } from '../context/user-turn.ts'
import { getModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'
import { createUserInput } from './user-input.ts'
import type { CoreEvent } from '../events.ts'
import { toViewEvent } from '../session/view-events.ts'

describe('运行中的多次压缩', () => {
  it('中止摘要保留原历史，新消息重试，快照写稳后即使停止也只提交一次', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'whycode-compact-stop-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const store = new SessionStore(directory)
    const entry = getModelEntry('openai:gpt-6.1-sol')
    const journal = await store.create({ workspace: localWorkspace(null), modelId: entry.id })
    const original: ModelMessage[] = [{ role: 'user', content: '早期任务' },
      { role: 'assistant', content: '早期工作记录'.repeat(40_000) },
      { role: 'user', content: '后续任务' }, { role: 'assistant', content: '近期工作记录'.repeat(6_000) }]
    await journal.recordSnapshot('rollback', original)
    const generating = deferred()
    const release = deferred()
    const saved = deferred()
    const publish = deferred()
    const model = new MockLanguageModelV4({ doGenerate: async () => {
      generating.resolve()
      await release.promise
      return { content: [{ type: 'text', text: '<summary>工作摘要</summary>' }],
        finishReason: { unified: 'stop', raw: undefined }, usage: usage(100), warnings: [] }
    } })
    const events: CoreEvent[] = []
    let written = Promise.resolve()
    const session = new AgentSession({ model: { ...entry, create: () => model,
      capabilities: { ...entry.capabilities, contextWindow: 96_000, maxOutput: 12_000 } },
      providerConfig: { apiKey: 'test' }, promptContext: { projectDir: directory, osPlatform: 'win32' },
      sessionRecorder: journal, requestApproval: async () => ({ approved: true }), emit: event => {
        events.push(event)
        const view = toViewEvent(event)
        if (view) written = journal.recordViewEvents([view])
      } })
    t.after(() => session.dispose())
    const first = session.handleUserMessage('第一次发言')
    await Promise.race([generating.promise, Promise.resolve(first).then(reason => assert.fail(`摘要尚未开始，回合已结束 ${reason}`))])
    await written
    const progress = () => events.filter(e => e.type === 'context-compaction')
    assert.deepEqual(progress().map(e => e.status), ['running'])
    const cold = await store.open(journal.sessionId)
    assert.deepEqual(cold.initialViewEvents.filter(e => e.type === 'core-event' && e.event.type === 'context-compaction'),
      [{ type: 'core-event', event: { ...progress()[0], status: 'stopped' } }])
    await assert.rejects(cold.readCompactionSummary(1), /找不到/)
    session.abort()
    release.resolve()
    assert.equal(await first, 'aborted')
    assert.deepEqual(progress().map(e => e.status), ['running', 'stopped'])
    assert.ok(session.captureMessageSnapshot().some(message => message.content === original[1]!.content))

    const recordSnapshot = journal.recordSnapshot.bind(journal)
    journal.recordSnapshot = async (...args) => {
      await recordSnapshot(...args)
      saved.resolve()
      await publish.promise
    }
    const second = session.handleUserMessage('请继续')
    await Promise.race([saved.promise, Promise.resolve(second).then(reason => assert.fail(`快照尚未保存，回合已结束 ${reason}`))])
    try {
      const reopened = await store.open(journal.sessionId)
      assert.equal((await reopened.readCompactionSummary(1)).historySummary, '工作摘要')
      const completed = reopened.initialViewEvents.filter(e => e.type === 'core-event' && e.event.type === 'context-compacted')
      assert.equal(completed.length, 1)
      assert.equal(events.some(e => e.type === 'context-compacted'), false)
      session.abort('process-interruption')
    } finally {
      publish.resolve()
    }
    assert.equal(await second, 'aborted')
    assert.deepEqual(progress().map(e => e.status), ['running', 'stopped', 'running'])
    assert.equal(events.filter(e => e.type === 'context-compacted').length, 1)
    assert.equal(model.doStreamCalls.length, 0)
    await written
    await assert.rejects(journal.readCompactionSummary(2), /找不到/)
  })

  it('协商协议、执行包和插话沿用原始用户任务，不推进近期附件窗口', async t => {
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: '完成' }, { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: usage(10) },
    ] }) }) })
    const session = new AgentSession({ model: { ...getModelEntry('openai:gpt-6.1-sol'), create: () => model },
      providerConfig: { apiKey: 'test' }, promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: () => {}, requestApproval: async () => ({ approved: true }) })
    t.after(() => session.dispose())
    const original = withUserTurn({ role: 'user', content: '完整用户原文' }, 'task-1', true)
    await session.handleExecutionMessage('第一轮协议', [], [], original)
    await session.handleExecutionMessage('后续协议提醒')
    await session.handleExecutionMessage('执行包', [createUserInput('执行时的用户补充', [], undefined, [], [])])
    const messages = session.captureMessageSnapshot()
    assert.deepEqual(recentPdfUserTurns(messages).map(turn => turn.id), ['task-1'])
    assert.equal(messages.filter(message => userTurn(message)?.startsTurn).length, 1)
    assert.equal(userTurn(messages.find(message => message.content === '执行时的用户补充')!)?.startsTurn, false)
    assert.ok(messages.some(message => message.content === original.content))
  })

  it('真实工具循环中的插话不新建摘要 turn，连续压缩更新同一前缀且工具声明不变', async t => {
    let step = 0
    let summaries = 0
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({ content: [{ type: 'text', text: `<summary>前缀累计 ${++summaries}</summary>` }],
        finishReason: { unified: 'stop', raw: undefined }, usage: usage(100), warnings: [] }),
      doStream: async () => {
        step++
        return { stream: simulateReadableStream({ chunks: [
          { type: 'text-start', id: `text-${step}` },
          { type: 'text-delta', id: `text-${step}`, delta: step < 6 ? `工作 ${step}:` + 'x'.repeat(step === 3 || step === 5 ? 75_000 : 50_000) : '完成' },
          { type: 'text-end', id: `text-${step}` },
          ...(step < 6 ? [{ type: 'tool-call' as const, toolCallId: `step-${step}`, toolName: 'WorkProbe', input: JSON.stringify({ step }) }] : []),
          { type: 'finish', finishReason: { unified: step < 6 ? 'tool-calls' : 'stop', raw: undefined },
            usage: usage(step === 3 || step === 5 ? 120_000 : 1000) },
        ] }) }
      },
    })
    const events: CoreEvent[] = []
    const session = new AgentSession({ model: { ...getModelEntry('openai:gpt-6.1-sol'),
      capabilities: { ...getModelEntry('openai:gpt-6.1-sol').capabilities, contextWindow: 128_000, maxOutput: 20_000 }, create: () => model },
      providerConfig: { apiKey: 'test' }, promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: event => events.push(event), requestApproval: async () => ({ approved: true }),
    })
    t.after(() => session.dispose())
    session.setExtraTools([buildTool({ name: 'WorkProbe', description: '工作探针', prompt: '工作探针',
      inputSchema: z.object({ step: z.number() }), isReadOnly: true, kind: 'read', execute: async () => {
        if (step === 3) session.handleUserMessage('插话纠正：保留取消路径', true)
        return { data: `工作证据 ${step}`, isError: false }
      } })])
    assert.equal(await session.handleUserMessage('完整正式任务原文'), 'completed')
    assert.equal(summaries, 2)
    assert.match(JSON.stringify(model.doGenerateCalls[1]!.prompt), /前缀累计 1/)
    const messages = session.captureMessageSnapshot()
    const users = messages.filter(message => userTurn(message)?.startsTurn)
    assert.equal(users.length, 1); assert.equal(users[0]?.content, '完整正式任务原文')
    const prefix = messages.map(parseCompactSummaryMessage).find(summary => summary?.turnPrefixSummary)
    assert.equal(prefix?.turnId, userTurn(users[0]!)?.id)
    assert.equal(prefix?.turnPrefixSummary, '前缀累计 2')
    assert.equal(events.filter(event => event.type === 'context-compacted' && event.level === 'full').length, 2)
    for (const request of model.doGenerateCalls) {
      assert.deepEqual(request.tools, model.doStreamCalls[0]!.tools)
      assert.deepEqual(request.toolChoice, model.doStreamCalls[0]!.toolChoice)
      assert.doesNotMatch(JSON.stringify(request.prompt), /"whycode":/)
    }
  })

  it('自动微压缩保存失败时原工具结果不变，也不发出普通请求', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'whycode-micro-commit-'))
    t.after(() => rm(directory, { recursive: true, force: true }))
    const store = new SessionStore(directory)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'openai:gpt-6.1-sol' })
    const model = new MockLanguageModelV4({})
    const events: CoreEvent[] = []
    const session = new AgentSession({ model: { ...getModelEntry('openai:gpt-6.1-sol'),
      capabilities: { ...getModelEntry('openai:gpt-6.1-sol').capabilities, contextWindow: 128_000, maxOutput: 20_000 }, create: () => model },
      providerConfig: { apiKey: 'test' }, promptContext: { projectDir: process.cwd(), osPlatform: 'win32' }, sessionRecorder: journal,
      emit: event => events.push(event), requestApproval: async () => ({ approved: true }) })
    t.after(() => session.dispose())
    const output = 'x'.repeat(400_000)
    const history: ModelMessage[] = [{ role: 'user', content: '旧任务' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'log', toolName: 'RunCommand', input: { command: 'echo' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'log', toolName: 'RunCommand', output: { type: 'text', value: output } }] }]
    await journal.recordSnapshot('rollback', history)
    session.restoreMessageSnapshot(history)
    journal.recordSnapshot = async () => { throw new Error('快照保存失败') }
    assert.equal(await session.handleUserMessage('继续'), 'error')
    assert.equal(model.doStreamCalls.length, 0)
    assert.ok(JSON.stringify(session.captureMessageSnapshot()).includes(output))
    assert.equal(events.some(event => event.type === 'context-compacted'), false)
    assert.ok(JSON.stringify((await store.open(journal.sessionId)).initialMessages).includes(output))
  })
})

function usage(input: number) {
  return { inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 10, text: 10, reasoning: undefined } }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
