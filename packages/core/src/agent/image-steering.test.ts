import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { importImageAttachments } from '../attachments/storage.ts'
import { ConsensusCoordinator } from '../consensus/orchestrator.ts'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { AgentSession } from './session.ts'
import { localWorkspace } from '../workspace/types.ts'

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

describe('忙时图片 steering', () => {
  it('协商期间排入的图片与文本各自开新任务，图片只在轮到它时交给 Main', async () => {
    await withImageSession(async ({ store, journal, attachments, root }) => {
      const reviewStarted = deferred<void>()
      const releaseReview = deferred<void>()
      const peer = { model: modelEntry(new MockLanguageModelV4({ doStream: async () => {
        reviewStarted.resolve()
        await releaseReview.promise
        return protocolStep({ vote: 'accept', reason: '已核对' })
      } })), providerConfig: { apiKey: 'test' } }
      const candidate = { summary: '核查结论', final_answer_or_plan: '提交结果' }
      const main = new MockLanguageModelV4({ doStream: [
        protocolStep({ protocol_mode: 'quick_review', candidate }), finalStep('原任务完成'),
        finalStep('图片任务完成'), protocolStep({ protocol_mode: 'main_only', candidate }), finalStep('文本任务完成'),
      ] })
      const events: CoreEvent[] = []
      const session = createSession(main, journal, events)
      const coordinator = new ConsensusCoordinator({
        mainSession: session, agents: { B: peer, C: peer }, projectDir: root,
        sessionScratchDir: join(root, 'scratch'), osPlatform: 'win32',
        emit: event => events.push(event), requestApproval: async () => ({ approved: false }),
        onTaskStart: (...args) => journal.recordConsensusTaskStart(...args),
        onTaskEnd: (...args) => journal.recordConsensusTaskEnd(...args),
      })
      await journal.recordUserInput('原始请求', true)
      const run = coordinator.handleUserMessage('原始请求')
      try {
        await reviewStarted.promise
        const imageId = randomUUID(), textId = randomUUID()
        await journal.recordUserInputWithId(imageId, '后续图片请求', false, attachments)
        coordinator.handleUserMessage('后续图片请求', false, attachments, imageId)
        await journal.recordUserInputWithId(textId, '后续文本请求', false)
        coordinator.handleUserMessage('后续文本请求', false, [], textId)
        assert.deepEqual(journal.pendingUserInputs.map(input => input.id), [imageId, textId])
      } finally { releaseReview.resolve() }
      await run
      const prompts = main.doStreamCalls.map(call => JSON.stringify(call.prompt))
      assert.equal(prompts.length, 5)
      assert.doesNotMatch(prompts[1]!, /后续图片请求|后续文本请求/)
      assert.match(prompts[2]!, /后续图片请求/)
      assert.ok(prompts[2]!.includes(ONE_PIXEL_PNG.toString('base64')))
      assert.doesNotMatch(prompts[2]!, /后续文本请求/)
      assert.match(prompts[3]!, /后续文本请求/)
      assert.deepEqual(events.flatMap(event => event.type === 'message-injected' ? [[event.text, event.startsTurn]] : []),
        [['后续图片请求', true], ['后续文本请求', true]])
      assert.deepEqual((await store.open(journal.sessionId)).pendingUserInputs, [])
    })
  })

  it('普通排队图片随正文开启新回合并原子确认送达', async () => {
    await withImageSession(async ({ store, journal, attachments }) => {
      const firstStarted = deferred<void>()
      const releaseFirst = deferred<void>()
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          if (call === 1) {
            firstStarted.resolve()
            await releaseFirst.promise
            return finalStep('初始步骤完成。')
          }
          const prompt = JSON.stringify(options.prompt)
          assert.match(prompt, /补充看这张图/)
          assert.equal(prompt.includes(ONE_PIXEL_PNG.toString('base64')), true)
          return finalStep('已结合补图完成。')
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(model, journal, events)
      await journal.recordUserInput('开始任务', true)
      const running = session.handleUserMessage('开始任务')
      await firstStarted.promise

      const inputId = randomUUID()
      await journal.recordUserInputWithId(inputId, '补充看这张图', false, attachments)
      assert.equal(session.handleUserMessage('补充看这张图', false, attachments, inputId), undefined)
      releaseFirst.resolve()

      assert.equal(await running, 'completed')
      assert.equal(call, 2)
      const queued = events.find((event) => event.type === 'message-queued')
      const injected = events.find((event) => event.type === 'message-injected')
      assert.deepEqual(queued?.type === 'message-queued' ? queued.attachments : undefined, attachments)
      assert.deepEqual(injected?.type === 'message-injected' ? injected.attachments : undefined, attachments)
      assert.equal(injected?.startsTurn, true)
      const reopened = await store.open(journal.sessionId)
      assert.deepEqual(reopened.pendingUserInputs, [])
      assert.equal(
        reopened.initialViewEvents.some((event) =>
          event.type === 'user-message'
          && event.text === '补充看这张图' && event.startsTurn
          && event.attachments?.[0]?.id === attachments[0]?.id),
        true,
      )
    })
  })

  it('送达确认落盘失败时模型看不到补图，队列仍可由重启恢复', async () => {
    await withImageSession(async ({ store, journal, attachments }) => {
      const firstStarted = deferred<void>()
      const releaseFirst = deferred<void>()
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async () => {
          call++
          firstStarted.resolve()
          await releaseFirst.promise
          return finalStep('第一步完成。')
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(model, journal, events)
      await journal.recordUserInput('开始', true)
      const running = session.handleUserMessage('开始')
      await firstStarted.promise

      const inputId = randomUUID()
      await journal.recordUserInputWithId(inputId, '必须先落盘的补图', false, attachments)
      const recordStart = journal.recordTurnStart.bind(journal)
      journal.recordTurnStart = async (...args: Parameters<typeof recordStart>) => {
        if (args[3]?.includes(inputId)) throw new Error('simulated fsync failure')
        await recordStart(...args)
      }
      session.handleUserMessage('必须先落盘的补图', false, attachments, inputId)
      releaseFirst.resolve()

      assert.equal(await running, 'error')
      assert.equal(call, 1)
      assert.equal(events.some((event) =>
        event.type === 'message-injected' && event.id === inputId), false)
      assert.equal(events.some((event) =>
        event.type === 'error' && event.message.includes('避免重复执行')), true)
      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.pendingUserInputs[0]?.id, inputId)
      assert.equal(reopened.pendingUserInputs[0]?.state, 'queued')
    })
  })

  it('urgent 图片丢弃未提交步骤后立即注入，不产生半截回答', async () => {
    await withImageSession(async ({ journal, attachments }) => {
      const firstStarted = deferred<void>()
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          if (call === 1) {
            firstStarted.resolve()
            await aborted(options.abortSignal)
            return finalStep('这段不应提交。')
          }
          assert.equal(
            JSON.stringify(options.prompt).includes(ONE_PIXEL_PNG.toString('base64')),
            true,
          )
          return finalStep('已优先处理紧急图片。')
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(model, journal, events)
      await journal.recordUserInput('执行较慢任务', true)
      const running = session.handleUserMessage('执行较慢任务')
      await firstStarted.promise
      const inputId = randomUUID()
      await journal.recordUserInputWithId(inputId, '紧急检查图片', false, attachments)
      session.handleUserMessage('紧急检查图片', true, attachments, inputId)

      assert.equal(await running, 'completed')
      assert.equal(call, 2)
      assert.equal(events.some((event) => event.type === 'step-discarded'), true)
      assert.equal(JSON.stringify(session.captureMessageSnapshot()).includes('这段不应提交'), false)
    })
  })

  it('停止和重启保留图片队列且 JSONL 不含 Base64', async () => {
    await withImageSession(async ({ store, journal, attachments, root }) => {
      const firstStarted = deferred<void>()
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          firstStarted.resolve()
          await aborted(options.abortSignal)
          return finalStep('不会提交。')
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(model, journal, events)
      await journal.recordUserInput('开始', true)
      const running = session.handleUserMessage('开始')
      await firstStarted.promise
      const inputId = randomUUID()
      await journal.recordUserInputWithId(inputId, '停止后恢复这张图', false, attachments)
      session.handleUserMessage('停止后恢复这张图', false, attachments, inputId)
      session.abort()

      assert.equal(await running, 'aborted')
      assert.equal(session.isQueuedUserInput(inputId), true)
      assert.deepEqual(journal.pendingUserInputs[0]?.attachments, attachments)
      const reopened = await store.open(journal.sessionId)
      await reopened.recoverInterruptedWork()
      assert.equal(reopened.pendingUserInputs[0]?.state, 'queued')
      assert.equal(reopened.pendingUserInputs[0]?.attachments?.[0]?.id, attachments[0]?.id)
      const transcript = await readFile(join(root, journal.sessionId, 'transcript.jsonl'), 'utf8')
      assert.doesNotMatch(transcript, /iVBORw0KGgo/)
    })
  })

  it('可单独编辑或丢弃仍在运行步骤后的排队消息', async () => {
    await withImageSession(async ({ store, journal }) => {
      const firstStarted = deferred<void>()
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          firstStarted.resolve()
          await aborted(options.abortSignal)
          return finalStep('不会提交。')
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(model, journal, events)
      await journal.recordUserInput('开始', true)
      const running = session.handleUserMessage('开始')
      await firstStarted.promise

      const editId = randomUUID()
      const nextId = randomUUID()
      const discardId = randomUUID()
      await journal.recordUserInputWithId(editId, '重新编辑我', false)
      session.handleUserMessage('重新编辑我', false, [], editId)
      await journal.recordUserInputWithId(nextId, '下一条草稿', false)
      session.handleUserMessage('下一条草稿', false, [], nextId)
      await journal.recordUserInputWithId(discardId, '丢弃我', false)
      session.handleUserMessage('丢弃我', false, [], discardId)

      assert.equal(await session.restoreQueuedMessage(editId), true)
      assert.equal(await session.restoreQueuedMessage(randomUUID(), [editId]), false)
      await assert.rejects(session.restoreQueuedMessage(nextId, [discardId]), /状态已变化/)
      assert.deepEqual(journal.pendingUserInputs.map(input => [input.id, input.state]), [
        [editId, 'restored'], [nextId, 'queued'], [discardId, 'queued'],
      ])
      assert.equal(await session.restoreQueuedMessage(nextId, [editId]), true)
      assert.equal(await session.discardQueuedMessage(discardId), true)
      assert.deepEqual(journal.pendingUserInputs.map(({ id, state }) => ({ id, state })), [
        { id: nextId, state: 'restored' },
      ])
      assert.deepEqual(events.flatMap(event => event.type === 'queued-message-edit-ready' ? [event.item.id] : []), [editId, nextId])
      assert.equal(events.some((event) =>
        event.type === 'message-dequeued' && event.id === discardId), true)

      session.abort()
      assert.equal(await running, 'aborted')
      const reopened = await store.open(journal.sessionId)
      assert.deepEqual(reopened.pendingUserInputs.map(({ id, state }) => ({ id, state })), [
        { id: nextId, state: 'restored' },
      ])
      await reopened.recordUserInputWithId(randomUUID(), '修改后的下一条', true, [], [nextId])
      assert.deepEqual((await store.open(journal.sessionId)).pendingUserInputs, [])
    })
  })

  it('只将选中的消息立即插入当前回合，剩余请求按 FIFO 各开一轮', async () => {
    await withImageSession(async ({ store, journal }) => {
      const firstStarted = deferred<void>()
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          if (call === 1) {
            firstStarted.resolve()
            await aborted(options.abortSignal)
            return finalStep('这段不应提交。')
          }
          return finalStep(`第 ${call} 次模型回复`)
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(model, journal, events)
      await journal.recordUserInput('开始', true)
      const running = session.handleUserMessage('开始')
      await firstStarted.promise
      const inputs = ['队首 A', '马上发送 B', '队尾 C', '队尾 D']
      const ids = inputs.map(() => randomUUID())
      for (const [index, input] of inputs.entries()) {
        await journal.recordUserInputWithId(ids[index]!, input, false)
        session.handleUserMessage(input, false, [], ids[index])
      }

      assert.equal(session.sendQueuedMessageNow(ids[1]!), true)
      assert.equal(await running, 'completed')
      assert.deepEqual(model.doStreamCalls.map(request => inputs.filter(input =>
        JSON.stringify(request.prompt).includes(input))), [
        [], [inputs[1]], inputs.slice(0, 2), inputs.slice(0, 3), inputs,
      ])
      assert.deepEqual(events.flatMap(event => event.type === 'message-injected' ? [[event.id, !!event.startsTurn]] : []),
        [[ids[1], false], [ids[0], true], [ids[2], true], [ids[3], true]])
      const starts = events.filter(event => event.type === 'turn-start').map(event => event.turnId)
      assert.equal(new Set(starts).size, 4)
      assert.deepEqual(events.filter(event => event.type === 'turn-end').map(event => event.turnId), starts)
      const cold = await store.open(journal.sessionId)
      assert.deepEqual(cold.pendingUserInputs, [])
      assert.deepEqual(cold.initialViewEvents.flatMap(event => event.type === 'user-message'
        ? [[event.text, event.startsTurn]] : []), [
        ['开始', true], [inputs[1], false], [inputs[0], true], [inputs[2], true], [inputs[3], true],
      ])
    })
  })
})

async function withImageSession(run: (context: {
  store: SessionStore
  journal: Awaited<ReturnType<SessionStore['create']>>
  attachments: Awaited<ReturnType<typeof importImageAttachments>>
  root: string
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'whycode-image-steering-'))
  try {
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:vision' })
    const source = join(root, 'source.png')
    await writeFile(source, ONE_PIXEL_PNG)
    const attachments = await importImageAttachments(
      [{ kind: 'path', path: source }],
      journal.attachmentDirectory,
      journal.sessionId,
    )
    await run({ store, journal, attachments, root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function createSession(
  model: MockLanguageModelV4,
  journal: Awaited<ReturnType<SessionStore['create']>>,
  events: CoreEvent[],
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    sessionRecorder: journal,
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
  })
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:vision',
    displayName: 'Image Steering Mock',
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
          usage: usage(),
        },
      ],
    }),
  }
}

function protocolStep(input: Record<string, unknown>) {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'tool-call' as const, toolCallId: randomUUID(), toolName: 'SubmitProtocolOutput', input: JSON.stringify(input) },
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: usage() },
  ] }) }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
}
