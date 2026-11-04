import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { it, type TestContext } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { parseTranscript } from '../session/chain.ts'
import { SessionStore } from '../session/store.ts'
import { toViewEvent } from '../session/view-events.ts'
import { localWorkspaceIO } from '../workspace/io.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession } from './session.ts'
import { inspectLatestTurnEdit } from './turn-edit.ts'

it('项目指令读取失败结束已接收的回合，可以连续编辑重发并从磁盘恢复', async t => {
  const f = await fixture(t)
  const read = t.mock.method(f.io.fs, 'readFile', async () => {
    throw new Error('工作区文件暂时不可读')
  })

  assert.equal((await f.send('原始问题')).outcome, 'error')
  assert.equal(f.session.isBusy, false)
  assert.equal(f.model.doStreamCalls.length, 0)
  assert.deepEqual(f.journal.undeliveredUserInputIds, [])
  assert.deepEqual(f.journal.pendingUserInputs, [])
  const firstTurn = f.latestTurnId()
  assert.ok(f.events.some(event => event.type === 'error'
    && event.message.includes('无法读取项目指令：工作区文件暂时不可读')))
  await f.session.inspectLatestTurnEdit(firstTurn)

  const cold = await f.store.open(f.journal.sessionId)
  assert.equal(cold.metadataSnapshot.status, 'error')
  assert.equal(cold.interruptedTurnId, null)
  assert.deepEqual(cold.undeliveredUserInputIds, [])
  await inspectLatestTurnEdit(cold, firstTurn)

  const edited = await f.session.prepareLatestTurnEdit(firstTurn, '仍然读取失败的问题')
  assert.equal(await edited.startMain(), 'error')
  await f.flushEvents()
  assert.deepEqual(f.journal.undeliveredUserInputIds, [])
  const retryTurn = f.latestTurnId()
  await f.session.inspectLatestTurnEdit(retryTurn)

  read.mock.restore()
  const retry = await f.session.prepareLatestTurnEdit(retryTurn, '恢复后重新编辑的问题')
  assert.equal(await retry.startMain(), 'completed')
  await f.flushEvents()
  assert.equal(f.model.doStreamCalls.length, 1)
  const prompt = JSON.stringify(f.model.doStreamCalls[0]?.prompt)
  assert.match(prompt, /恢复后重新编辑的问题/)
  assert.doesNotMatch(prompt, /原始问题|仍然读取失败的问题/)
  const reopened = await f.store.open(f.journal.sessionId)
  assert.equal(JSON.stringify(reopened.initialMessages), JSON.stringify(f.journal.initialMessages))
  await inspectLatestTurnEdit(reopened, f.latestTurnId())
})

it('启动失败不会阻止后续普通输入完成和编辑，失败回合有持久终态', async t => {
  const f = await fixture(t)
  const read = t.mock.method(f.io.fs, 'readFile', async () => { throw new Error('读取失败') })
  const failed = await f.send('第一次问题')
  assert.equal(failed.outcome, 'error')
  const failedTurn = f.latestTurnId()
  read.mock.restore()

  assert.equal((await f.send('后续问题')).outcome, 'completed')
  const latestTurn = f.latestTurnId()
  await f.session.inspectLatestTurnEdit(latestTurn)
  await assert.rejects(f.session.inspectLatestTurnEdit(failedTurn), /只能编辑最新/)
  const entries = parseTranscript(await readFile(f.transcript, 'utf8'))
  assert.ok(entries.some(entry => entry.type === 'turn-start'
    && entry.turnId === failedTurn && entry.rootInputId === failed.inputId))
  assert.ok(entries.some(entry => entry.type === 'turn-end'
    && entry.turnId === failedTurn && entry.stopReason === 'error'))
  const cold = await f.store.open(f.journal.sessionId)
  assert.equal(cold.metadataSnapshot.status, 'idle')
  assert.equal(cold.interruptedTurnId, null)
  assert.deepEqual(cold.undeliveredUserInputIds, [])
  assert.deepEqual(cold.pendingUserInputs, [])
  await inspectLatestTurnEdit(cold, latestTurn)
})

it('读取项目指令期间停止会结束回合，并保留真正排队输入的恢复与编辑保护', async t => {
  const f = await fixture(t)
  const reading = deferred()
  const release = deferred()
  const read = t.mock.method(f.io.fs, 'readFile', async () => {
    reading.resolve()
    await release.promise
    throw new Error('读取期间连接断开')
  })
  const running = f.send('正在准备的回合')
  const queuedId = randomUUID()
  try {
    await reading.promise
    await f.journal.recordUserInputWithId(queuedId, '保留的排队输入', false)
    f.session.handleUserMessage('保留的排队输入', false, [], queuedId)
    f.session.abort()
  } finally {
    release.resolve()
  }
  assert.equal((await running).outcome, 'aborted')
  assert.equal(f.model.doStreamCalls.length, 0)
  assert.equal(f.session.isBusy, false)
  assert.deepEqual(f.journal.undeliveredUserInputIds, [])
  assert.deepEqual(f.journal.pendingUserInputs.map(({ id, state }) => ({ id, state })), [
    { id: queuedId, state: 'restored' },
  ])
  assert.ok(f.events.some(event => event.type === 'queue-restored'
    && event.items?.[0]?.id === queuedId))
  await assert.rejects(f.session.inspectLatestTurnEdit(f.latestTurnId()), /待处理输入/)
  const cold = await f.store.open(f.journal.sessionId)
  assert.deepEqual(cold.pendingUserInputs, f.journal.pendingUserInputs)
  await assert.rejects(inspectLatestTurnEdit(cold, f.latestTurnId()), /待处理输入/)

  read.mock.restore()
  assert.equal((await f.send('重新提交排队输入', [queuedId])).outcome, 'completed')
  assert.deepEqual(f.journal.pendingUserInputs, [])
  await f.session.inspectLatestTurnEdit(f.latestTurnId())
})

it('启动失败不清除用户主动退回草稿的输入', async t => {
  const f = await fixture(t)
  const reading = deferred()
  const release = deferred()
  t.mock.method(f.io.fs, 'readFile', async () => {
    reading.resolve()
    await release.promise
    throw new Error('读取失败')
  })
  const running = f.send('当前问题')
  const restoredId = randomUUID()
  try {
    await reading.promise
    await f.journal.recordUserInputWithId(restoredId, '待编辑草稿', false)
    f.session.handleUserMessage('待编辑草稿', false, [], restoredId)
    assert.equal(await f.session.restoreQueuedMessage(restoredId), true)
  } finally {
    release.resolve()
  }
  assert.equal((await running).outcome, 'error')
  assert.deepEqual(f.journal.undeliveredUserInputIds, [])
  assert.equal(f.journal.pendingUserInputs[0]?.id, restoredId)
  assert.equal(f.journal.pendingUserInputs[0]?.state, 'restored')
  await assert.rejects(f.session.inspectLatestTurnEdit(f.latestTurnId()), /待处理输入/)
})

it('回合起点保存失败仍保留未交付输入，不读取工作区或调用模型', async t => {
  const f = await fixture(t)
  const read = t.mock.method(f.io.fs, 'readFile', async () => { throw new Error('不应读取') })
  t.mock.method(f.journal, 'recordTurnStart', async () => { throw new Error('模拟日志写入失败') })
  const result = await f.send('待安全保存的输入')
  assert.equal(result.outcome, 'error')
  assert.equal(f.session.isBusy, false)
  assert.equal(read.mock.callCount(), 0)
  assert.equal(f.model.doStreamCalls.length, 0)
  assert.deepEqual(f.journal.undeliveredUserInputIds, [result.inputId])
  assert.equal(f.events.some(event => event.type === 'turn-start'), false)
  assert.ok(f.events.some(event => event.type === 'error' && event.message.includes('模拟日志写入失败')))
  const cold = await f.store.open(f.journal.sessionId)
  assert.deepEqual(cold.undeliveredUserInputIds, [result.inputId])
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-turn-start-failure-'))
  const store = new SessionStore(join(root, 'sessions'))
  const journal = await store.create({ workspace: localWorkspace(root), modelId: 'test:startup' })
  const io = { ...localWorkspaceIO, fs: { ...localWorkspaceIO.fs } }
  const model = new MockLanguageModelV4({ doStream: async () => ({
    stream: simulateReadableStream({ chunks: [
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: '处理完成' },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      } },
    ] }),
  }) })
  const entry: ModelEntry = {
    id: 'test:startup', displayName: 'Startup test', provider: 'openai', protocol: 'openai-responses',
    capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000 },
    create: () => model,
  }
  const events: CoreEvent[] = []
  const session = new AgentSession({
    model: entry, providerConfig: { apiKey: 'test' }, sessionRecorder: journal, workspaceIO: io,
    promptContext: { projectDir: root, homeDir: root, osPlatform: process.platform },
    emit: event => events.push(event), requestApproval: async () => ({ approved: false }),
  })
  t.after(async () => {
    await session.dispose()
    const target = resolve(root)
    assert.equal(dirname(target), resolve(tmpdir()))
    assert.ok(basename(target).startsWith('whycode-turn-start-failure-'))
    await rm(target, { recursive: true, force: true })
  })
  let flushed = 0
  async function flushEvents() {
    const pending = events.slice(flushed)
    await journal.recordViewEvents(pending.flatMap(event => {
      const view = toViewEvent(event)
      return view ? [view] : []
    }))
    flushed += pending.length
  }
  return {
    store, journal, io, model, session, events, flushEvents,
    transcript: join(root, 'sessions', journal.sessionId, 'transcript.jsonl'),
    latestTurnId() {
      const turn = events.findLast(event => event.type === 'turn-start')
      assert.ok(turn)
      return turn.turnId
    },
    async send(text: string, consumesInputIds: string[] = []) {
      const inputId = randomUUID()
      await journal.recordUserInputWithId(inputId, text, true, [], consumesInputIds)
      const outcome = await session.handleUserMessage(text, false, [], inputId)
      await flushEvents()
      return { outcome, inputId }
    },
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
