import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it, type TestContext } from 'node:test'
import { AgentSession, SessionStore, localWorkspace, type CoreEvent, type ModelEntry } from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { SessionRuntimeRegistry } from './session-runtime-registry.ts'
import { handleQueuedMessageAction } from './queued-message-actions.ts'

it('空闲立即发送只先交付选中项，IPC 不等待模型，并在完成后按 FIFO 接续', async t => {
  const f = await fixture(t)
  const result = await f.action('send-now', f.ids[1]!)
  assert.equal(result.ok, true)
  await f.started.promise
  assert.equal(f.runtime.routingGate.busy, false)
  assert.equal(f.runtime.session?.isBusy, true)
  assert.deepEqual(f.journal.pendingUserInputs.map(input => input.text), ['A', 'C'])
  assert.deepEqual(injected(f.events), ['B'])
  f.release.resolve()
  await f.runtime.waitUntilIdle()
  assert.deepEqual(injected(f.events), ['B', 'A', 'C'])
  assert.deepEqual(f.journal.pendingUserInputs, [])
})

for (const shutdown of [false, true]) {
  it(`${shutdown ? '关闭应用' : '用户停止'}保留其它排队项，重新打开不会自动执行`, async t => {
    const f = await fixture(t)
    assert.equal((await f.action('send-now', f.ids[1]!)).ok, true)
    await f.started.promise
    if (shutdown) await f.registry.closeAll()
    else {
      await f.runtime.abort()
      await f.runtime.waitUntilIdle()
    }
    assert.equal(f.calls.value, 1)
    assert.deepEqual(f.journal.pendingUserInputs.map(input => [input.text, input.state]), [['A', 'queued'], ['C', 'queued']])
    const reopened = await f.store.open(f.journal.sessionId)
    await reopened.recoverInterruptedWork()
    assert.equal(reopened.metadataSnapshot.status, 'idle')
    assert.deepEqual(reopened.pendingUserInputs.map(input => input.text), ['A', 'C'])
    const cold = f.createSession(reopened)
    t.after(() => cold.dispose())
    assert.equal(cold.isBusy, false)
    assert.equal(f.calls.value, 1)
  })
}

it('模型未初始化的会话仍可编辑、处理覆盖失败和删除队列，不建立运行名额', async t => {
  const f = await fixture(t)
  let prepared = 0
  const host = { reserveWorkStart: () => { throw new Error('编辑不应占名额') },
    prepareExecution: async () => { prepared++ }, onDeliveryError: () => {} }
  const action = (id: string, type: 'edit' | 'discard', replaced?: string[]) => handleQueuedMessageAction(f.runtime, {
    type: 'queued-message-action', id, action: type, replacesRestoredInputIds: replaced,
  }, host)
  assert.equal((await action(f.ids[0]!, 'edit')).ok, true)
  assert.equal(f.runtime.session, null)
  assert.equal(prepared, 0)
  assert.deepEqual(f.journal.pendingUserInputs.map(input => input.state), ['restored', 'queued', 'queued'])
  assert.equal((await action(f.ids[1]!, 'edit', ['invalid-draft-id'])).ok, false)
  assert.deepEqual(f.journal.pendingUserInputs.map(input => input.state), ['restored', 'queued', 'queued'])
  assert.equal((await action(f.ids[1]!, 'edit', [f.ids[0]!])).ok, true)
  assert.equal((await action(f.ids[2]!, 'discard')).ok, true)
  assert.deepEqual(f.journal.pendingUserInputs.map(input => [input.id, input.state]), [[f.ids[1], 'restored']])
  assert.equal(f.events.filter(event => event.type === 'queued-message-edit-ready').length, 2)
  const reopened = await f.store.open(f.journal.sessionId)
  assert.deepEqual(reopened.pendingUserInputs, f.journal.pendingUserInputs)
})

it('容量或连接准入失败时不消费排队输入，失败后允许重试', async t => {
  const f = await fixture(t)
  const other = new DesktopSessionRuntime({ workspace: localWorkspace(f.root), modelId: 'test:queue', emit: () => {} })
  f.registry.add(other)
  const reservation = f.registry.reserveWorkStart(other)!
  assert.equal((await f.action('send-now', f.ids[0]!)).ok, false)
  assert.equal(f.runtime.session, null)
  reservation.release()
  const failed = await handleQueuedMessageAction(f.runtime, {
    type: 'queued-message-action', action: 'send-now', id: f.ids[0]!,
  }, { reserveWorkStart: () => f.registry.reserveWorkStart(f.runtime),
    prepareExecution: async () => { throw new Error('连接不可用') }, onDeliveryError: () => {} })
  assert.equal(failed.ok, false)
  assert.match(failed.error!, /连接不可用/)
  assert.equal(f.runtime.routingGate.busy, false)
  assert.deepEqual(f.journal.pendingUserInputs.map(input => input.id), f.ids)
  assert.equal((await f.action('send-now', f.ids[0]!)).ok, true)
  await f.started.promise
  f.release.resolve()
  await f.runtime.waitUntilIdle()
  assert.deepEqual(injected(f.events), ['A', 'B', 'C'])
})

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-queued-actions-'))
  const store = new SessionStore(join(root, 'sessions'))
  const journal = await store.create({ workspace: localWorkspace(root), modelId: 'test:queue' })
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  for (const [i, text] of ['A', 'B', 'C'].entries()) await journal.recordUserInputWithId(ids[i]!, text, false)
  const events: CoreEvent[] = []
  const runtime = new DesktopSessionRuntime({ workspace: localWorkspace(root), modelId: 'test:queue', emit: (_runtime, event) => events.push(event) })
  runtime.journal = journal
  const registry = new SessionRuntimeRegistry({ maxConcurrentRuns: 1, idleUnloadMs: -1 })
  registry.add(runtime)
  const started = deferred(), release = deferred()
  const calls = { value: 0 }
  const model: Extract<ReturnType<ModelEntry['create']>, { specificationVersion: 'v4' }> = {
    specificationVersion: 'v4', provider: 'test', modelId: 'test:queue', supportedUrls: {},
    doGenerate: async () => { throw new Error('不应生成摘要') },
    doStream: async options => {
      calls.value++
      if (calls.value === 1) {
        started.resolve()
        await Promise.race([release.promise, new Promise<void>(done => {
          if (options.abortSignal?.aborted) done()
          else options.abortSignal?.addEventListener('abort', () => done(), { once: true })
        })])
      }
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'text-start', id: 'answer' })
        controller.enqueue({ type: 'text-delta', id: 'answer', delta: '完成' })
        controller.enqueue({ type: 'text-end', id: 'answer' })
        controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        } })
        controller.close()
      } }) }
    },
  }
  const entry: ModelEntry = { id: 'test:queue', displayName: 'Queue test', provider: 'openai', protocol: 'openai-responses',
    capabilities: { supportsNativeTools: true, supportsImageInput: false, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000 },
    create: () => model,
  }
  function createSession(recorder = journal) {
    return new AgentSession({ model: entry, providerConfig: { apiKey: 'test' }, sessionRecorder: recorder,
      promptContext: { projectDir: root, homeDir: root, osPlatform: process.platform },
      emit: event => runtime.emit(event), onQueuedTurnStart: () => runtime.beginQueuedTurn(),
      requestApproval: async () => ({ approved: false }),
    })
  }
  t.after(async () => {
    release.resolve()
    await registry.closeAll()
    await rm(root, { recursive: true, force: true })
  })
  return { root, store, journal, ids, runtime, registry, calls, events, started, release, createSession,
    action: (action: 'edit' | 'discard' | 'send-now', id: string) => handleQueuedMessageAction(runtime,
      { type: 'queued-message-action', action, id }, {
        reserveWorkStart: () => registry.reserveWorkStart(runtime),
        prepareExecution: async () => { runtime.session ??= createSession() },
        onDeliveryError: error => runtime.emit({ type: 'error', message: String(error), recoverable: true }),
      }),
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function injected(events: CoreEvent[]) {
  return events.flatMap(event => event.type === 'message-injected' ? [event.text] : [])
}
