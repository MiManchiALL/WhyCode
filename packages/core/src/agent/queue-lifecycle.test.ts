import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { ConsensusCoordinator } from '../consensus/orchestrator.ts'
import { userTurn } from '../context/user-turn.ts'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore, type SessionJournal } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'

for (const reason of ['user-cancel', 'process-interruption'] as const) {
  it(`${reason} 保留队列；新请求优先执行，正常完成后逐条消费原队列`, async t => {
    const firstStarted = deferred()
    const model: MockLanguageModelV4 = new MockLanguageModelV4({ doStream: async options => {
      if (model.doStreamCalls.length === 1) {
        firstStarted.resolve()
        await aborted(options.abortSignal)
      }
      return finalStep()
    } })
    const f = await fixture(t, model)
    const running = f.send('active')
    await firstStarted.promise
    const ids = [await f.enqueue('A'), await f.enqueue('B')]
    f.session.abort(reason)
    assert.equal(await running, 'aborted')
    assert.equal(f.session.isBusy, false)
    assert.equal(model.doStreamCalls.length, 1)
    assert.deepEqual(f.journal.pendingUserInputs.map(input => [input.id, input.state]), ids.map(id => [id, 'queued']))
    assert.deepEqual(injected(f.events), [])

    assert.equal(await f.send('X'), 'completed')
    assert.deepEqual(roots(f.session), ['active', 'X', 'A', 'B'])
    assert.deepEqual(injected(f.events), ['A', 'B'])
    assert.deepEqual(f.journal.pendingUserInputs, [])
  })
}

it('停止后重发最新消息，编辑回合完成才按原顺序交付队列，取回的草稿独立保留', async t => {
  const started = deferred()
  const model: MockLanguageModelV4 = new MockLanguageModelV4({ doStream: async options => {
    if (model.doStreamCalls.length === 1) {
      started.resolve()
      await aborted(options.abortSignal)
    }
    return finalStep()
  } })
  const f = await fixture(t, model)
  const running = f.send('停止前的问题')
  await started.promise
  await f.enqueue('排队甲')
  const draftId = await f.enqueue('取回的草稿')
  await f.enqueue('排队乙')
  f.session.abort()
  assert.equal(await running, 'aborted')
  const original = f.events.find(event => event.type === 'turn-start')
  assert.ok(original)
  await f.journal.recordViewEvents([{ type: 'core-event', event: original }])
  await f.session.inspectLatestTurnEdit(original.turnId)
  assert.equal(await f.session.restoreQueuedMessage(draftId), true)
  const pending = f.journal.pendingUserInputs

  const edit = await f.session.prepareLatestTurnEdit(original.turnId, '编辑后的问题')
  assert.deepEqual((await f.store.open(f.journal.sessionId)).pendingUserInputs, pending)
  assert.equal(model.doStreamCalls.length, 1)
  const beforeStart = f.events.length
  assert.equal(await edit.startMain(), 'completed')
  assert.deepEqual(roots(f.session), ['编辑后的问题', '排队甲', '排队乙'])
  const deliveries = f.events.slice(beforeStart).filter(event => event.type === 'turn-end' || event.type === 'message-injected')
  assert.deepEqual(deliveries.map(event => event.type === 'turn-end' ? event.stopReason : event.text),
    ['completed', '排队甲', 'completed', '排队乙', 'completed'])
  const cold = await f.store.open(f.journal.sessionId)
  assert.deepEqual(cold.pendingUserInputs.map(input => [input.id, input.state]), [[draftId, 'restored']])
})

it('最终请求失败保留队列，恢复后的新请求完成才接续', async t => {
  const started = deferred(), release = deferred()
  const model = new MockLanguageModelV4({ doStream: async () => {
    if (model.doStreamCalls.length === 1) {
      started.resolve()
      await release.promise
      return { stream: simulateReadableStream({ chunks: [{ type: 'error', error: new Error('请求失败') }] }) }
    }
    return finalStep()
  } })
  const f = await fixture(t, model)
  const running = f.send('active')
  await started.promise
  const id = await f.enqueue('A')
  release.resolve()
  assert.equal(await running, 'error')
  assert.equal(model.doStreamCalls.length, 1)
  assert.equal(f.journal.pendingUserInputs[0]?.id, id)
  assert.equal((await f.store.open(f.journal.sessionId)).metadataSnapshot.status, 'error')
  assert.equal(await f.send('X'), 'completed')
  assert.deepEqual(roots(f.session), ['active', 'X', 'A'])
})

it('冷恢复保留队列，读取与手动压缩不发送它，显式新请求完成后恢复 FIFO', async t => {
  const f = await fixture(t, new MockLanguageModelV4({ doStream: async () => finalStep() }))
  await f.journal.recordUserInput('active', true)
  await f.journal.recordTurnStart('crashed', [{ role: 'user', content: 'active' }])
  const ids = [randomUUID(), randomUUID()]
  await f.journal.recordUserInputWithId(ids[0]!, 'A', false)
  await f.journal.recordUserInputWithId(ids[1]!, 'B', false)
  const journal = await f.store.open(f.journal.sessionId)
  await journal.recoverInterruptedWork()
  const model = new MockLanguageModelV4({
    doStream: async () => finalStep(),
    doGenerate: async () => ({ content: [{ type: 'text', text: '此前请求被中止。' }],
      finishReason: { unified: 'stop', raw: undefined }, usage: usage(), warnings: [] }),
  })
  const session = createSession(model, journal, [])
  t.after(() => session.dispose())
  assert.equal(session.isBusy, false)
  assert.equal(model.doStreamCalls.length, 0)
  assert.deepEqual(journal.pendingUserInputs.map(input => input.id), ids)
  assert.ok(journal.pendingUserInputs.every(input => input.state === 'queued'))
  assert.equal(journal.metadataSnapshot.status, 'idle')
  await session.compactNow()
  assert.equal(model.doStreamCalls.length, 0)
  assert.equal(model.doGenerateCalls.length, 1)
  const reopened = await f.store.open(journal.sessionId)
  assert.deepEqual(reopened.pendingUserInputs.map(input => input.id), ids)
  assert.equal(reopened.metadataSnapshot.status, 'idle')

  await session.handleUserMessage('X')
  assert.deepEqual(roots(session).slice(-3), ['X', 'A', 'B'])
  assert.deepEqual(journal.pendingUserInputs, [])
})

it('空闲时立即发送指定 ID，剩余消息保持原顺序并在后续回合交付', async t => {
  const f = await fixture(t, new MockLanguageModelV4({ doStream: async () => finalStep() }))
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  for (const [i, text] of ['A', 'B', 'C'].entries()) await f.journal.recordUserInputWithId(ids[i]!, text, false)
  const model = new MockLanguageModelV4({ doStream: async () => finalStep() })
  const events: CoreEvent[] = []
  const session = createSession(model, f.journal, events)
  t.after(() => session.dispose())
  assert.equal(await session.sendQueuedMessageNow(ids[1]!), 'completed')
  assert.deepEqual(roots(session), ['B', 'A', 'C'])
  assert.deepEqual(injected(events), ['B', 'A', 'C'])
  assert.deepEqual(f.journal.pendingUserInputs, [])
})

for (const outcome of ['aborted', 'error'] as const) {
  it(`协商 ${outcome} 后保留队列，新请求与旧队列分别完成完整任务`, async t => {
    const started = deferred(), release = deferred()
    const model: MockLanguageModelV4 = new MockLanguageModelV4({ doStream: async options => {
      if (model.doStreamCalls.length === 2) {
        started.resolve()
        if (outcome === 'aborted') await aborted(options.abortSignal)
        else {
          await release.promise
          return { stream: simulateReadableStream({ chunks: [{ type: 'error', error: new Error('执行失败') }] }) }
        }
      }
      return model.doStreamCalls.length % 2 === 1 ? protocolStep() : finalStep()
    } })
    const f = await fixture(t, model)
    const coordinator = createCoordinator(f.session, f.journal, f.events, f.root, model)
    await f.journal.recordUserInput('active', true)
    const running = coordinator.handleUserMessage('active')
    await started.promise
    const id = randomUUID()
    await f.journal.recordUserInputWithId(id, 'A', false)
    coordinator.handleUserMessage('A', false, [], id)
    if (outcome === 'aborted') await coordinator.abort()
    else release.resolve()
    assert.equal(await running, outcome)
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(f.session.isQueuedUserInput(id), true)
    assert.equal(f.journal.pendingUserInputs[0]?.state, 'queued')

    await f.journal.recordUserInput('X', true)
    assert.equal(await coordinator.handleUserMessage('X'), 'completed')
    assert.equal(model.doStreamCalls.length, 6)
    assert.deepEqual(injected(f.events), ['A'])
    assert.deepEqual(f.journal.pendingUserInputs, [])
    assert.match(JSON.stringify(model.doStreamCalls[2]?.prompt), /X/)
    assert.match(JSON.stringify(model.doStreamCalls[4]?.prompt), /A/)
  })
}

it('协商冷恢复的指定排队输入仍经协商流程执行', async t => {
  const model: MockLanguageModelV4 = new MockLanguageModelV4({ doStream: async () =>
    model.doStreamCalls.length % 2 === 1 ? protocolStep() : finalStep() })
  const f = await fixture(t, model)
  const a = randomUUID(), b = randomUUID()
  await f.journal.recordUserInputWithId(a, 'A', false)
  await f.journal.recordUserInputWithId(b, 'B', false)
  const session = createSession(model, f.journal, f.events)
  t.after(() => session.dispose())
  const coordinator = createCoordinator(session, f.journal, f.events, f.root, model)
  assert.equal(await coordinator.sendQueuedMessageNow(b), 'completed')
  assert.deepEqual(injected(f.events), ['B', 'A'])
  assert.equal(model.doStreamCalls.length, 4)
  assert.deepEqual(f.journal.pendingUserInputs, [])
})

it('协商执行收尾时立即发送选中项，交接队列后仍优先于普通排队输入', async t => {
  const settling = deferred(), release = deferred()
  const model: MockLanguageModelV4 = new MockLanguageModelV4({ doStream: async () =>
    model.doStreamCalls.length % 2 === 1 ? protocolStep() : finalStep() })
  const f = await fixture(t, model)
  const coordinator = createCoordinator(f.session, f.journal, f.events, f.root, model)
  const recordEnd = f.journal.recordTurnEnd.bind(f.journal)
  let endedTurns = 0
  t.mock.method(f.journal, 'recordTurnEnd', async (...args: Parameters<typeof recordEnd>) => {
    await recordEnd(...args)
    if (++endedTurns === 2) { settling.resolve(); await release.promise }
  })
  await f.journal.recordUserInput('active', true)
  const running = coordinator.handleUserMessage('active')
  await settling.promise
  const ids = [randomUUID(), randomUUID()]
  for (const [i, text] of ['A', 'B'].entries()) {
    await f.journal.recordUserInputWithId(ids[i]!, text, false)
    coordinator.handleUserMessage(text, false, [], ids[i]!)
  }
  assert.equal(coordinator.sendQueuedMessageNow(ids[1]!), true)
  release.resolve()
  assert.equal(await running, 'completed')
  assert.deepEqual(injected(f.events), ['B', 'A'])
  assert.deepEqual(f.journal.pendingUserInputs, [])
})

it('评审期间停止保留混合插话的持久顺序，退出协商后仍可正常消费', async t => {
  const reviewStarted = deferred()
  const model: MockLanguageModelV4 = new MockLanguageModelV4({ doStream: async () =>
    model.doStreamCalls.length === 1 ? protocolStep('quick_review') : finalStep() })
  const peer = new MockLanguageModelV4({ doStream: async options => {
    reviewStarted.resolve()
    await aborted(options.abortSignal)
    return finalStep()
  } })
  const f = await fixture(t, model)
  const coordinator = createCoordinator(f.session, f.journal, f.events, f.root, peer)
  await f.journal.recordUserInput('active', true)
  const running = coordinator.handleUserMessage('active')
  await reviewStarted.promise
  const ids: string[] = []
  for (const text of ['A', 'B', 'C']) {
    const id = randomUUID()
    ids.push(id)
    await f.journal.recordUserInputWithId(id, text, false)
    coordinator.handleUserMessage(text, text === 'B', [], id)
  }
  coordinator.abort()
  assert.equal(await running, 'aborted')
  assert.deepEqual(f.journal.pendingUserInputs.map(input => input.id), ids)
  assert.deepEqual(injected(f.events), [])
  assert.equal(await f.send('X'), 'completed')
  assert.deepEqual(injected(f.events), ['A', 'B', 'C'])
  assert.deepEqual(f.journal.pendingUserInputs, [])
})

async function fixture(t: TestContext, model: MockLanguageModelV4) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-queue-lifecycle-'))
  const store = new SessionStore(join(root, 'sessions'))
  const journal = await store.create({ workspace: localWorkspace(root), modelId: 'test:queue' })
  const events: CoreEvent[] = []
  const session = createSession(model, journal, events)
  t.after(async () => {
    session.abort()
    await session.waitUntilIdle()
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return {
    root, store, journal, events, session,
    async send(text: string) {
      const id = randomUUID()
      await journal.recordUserInputWithId(id, text, true)
      return session.handleUserMessage(text, false, [], id)
    },
    async enqueue(text: string) {
      const id = randomUUID()
      await journal.recordUserInputWithId(id, text, false)
      session.handleUserMessage(text, false, [], id)
      return id
    },
  }
}

function createSession(model: MockLanguageModelV4, journal: SessionJournal, events: CoreEvent[]) {
  return new AgentSession({ model: entry(model), providerConfig: { apiKey: 'test' }, sessionRecorder: journal,
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' }, emit: event => events.push(event),
    requestApproval: async () => ({ approved: false }),
  })
}

function createCoordinator(session: AgentSession, journal: SessionJournal, events: CoreEvent[], root: string, model: MockLanguageModelV4) {
  const peer = { model: entry(model), providerConfig: { apiKey: 'test' } }
  return new ConsensusCoordinator({ mainSession: session, projectDir: root, sessionScratchDir: join(root, 'scratch'),
    agents: { B: peer, C: peer }, osPlatform: 'win32', emit: event => events.push(event),
    requestApproval: async () => ({ approved: false }),
    onTaskStart: (...args) => journal.recordConsensusTaskStart(...args),
    onTaskEnd: (...args) => journal.recordConsensusTaskEnd(...args),
  })
}

function entry(model: MockLanguageModelV4): ModelEntry {
  return { id: 'test:queue', displayName: 'Queue test', provider: 'openai', protocol: 'openai-responses',
    capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000 },
    create: () => model,
  }
}

function roots(session: AgentSession) {
  return session.captureMessageSnapshot().filter(message => userTurn(message)?.startsTurn).map(message => message.content)
}

function injected(events: CoreEvent[]) {
  return events.flatMap(event => event.type === 'message-injected' ? [event.text] : [])
}

function finalStep() {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'text-start' as const, id: 'answer' },
    { type: 'text-delta' as const, id: 'answer', delta: '完成' },
    { type: 'text-end' as const, id: 'answer' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: usage() },
  ] }) }
}

function protocolStep(mode = 'main_only') {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'tool-call' as const, toolCallId: randomUUID(), toolName: 'SubmitProtocolOutput',
      input: JSON.stringify({ protocol_mode: mode, candidate: { summary: '结论', final_answer_or_plan: '执行请求' } }) },
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: usage() },
  ] }) }
}

function usage() {
  return { inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined } }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function aborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
}
