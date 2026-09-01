import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { importImageAttachments } from '../attachments/storage.ts'
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
  it('B/C 期间暂存的图片在执行边界作为独立 Main 消息交付', async () => {
    await withImageSession(async ({ store, journal, attachments }) => {
      const inputId = randomUUID()
      let call = 0
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          call++
          const prompt = JSON.stringify(options.prompt)
          assert.match(prompt, /协商执行包/)
          assert.match(prompt, /协商期间补充图片/)
          assert.equal(prompt.includes(ONE_PIXEL_PNG.toString('base64')), true)
          return finalStep('已在 Main 执行阶段处理补图。')
        },
      })
      const session = createSession(model, journal, [])
      await journal.recordUserInputWithId(inputId, '协商期间补充图片', false, attachments)

      const result = session.handleExecutionMessage('协商执行包', [{
        id: inputId,
        text: '协商期间补充图片',
        attachments,
        imageDelivery: 'native',
      }])
      assert.equal(await result, 'completed')
      assert.equal(call, 1)
      assert.deepEqual((await store.open(journal.sessionId)).pendingUserInputs, [])
    })
  })

  it('正文与图片按 FIFO 在稳定步骤间一起注入并原子确认送达', async () => {
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
      const reopened = await store.open(journal.sessionId)
      assert.deepEqual(reopened.pendingUserInputs, [])
      assert.equal(
        reopened.initialViewEvents.some((event) =>
          event.type === 'user-message'
          && event.text === '补充看这张图'
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
      const recordStep = journal.recordStep.bind(journal)
      journal.recordStep = async (...args: Parameters<typeof recordStep>) => {
        const deliveredInputIds = args[4]?.deliveredInputIds ?? []
        if (deliveredInputIds.includes(inputId)) throw new Error('simulated fsync failure')
        await recordStep(...args)
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

  it('停止和重启把图片队列恢复为可重提草稿且 JSONL 不含 Base64', async () => {
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
      const restoredEvent = events.find((event) => event.type === 'queue-restored')
      assert.equal(restoredEvent?.type === 'queue-restored' ? restoredEvent.items?.[0]?.id : '', inputId)
      assert.deepEqual(
        restoredEvent?.type === 'queue-restored' ? restoredEvent.items?.[0]?.attachments : undefined,
        attachments,
      )
      const reopened = await store.open(journal.sessionId)
      assert.equal(reopened.pendingUserInputs[0]?.state, 'restored')
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
      const discardId = randomUUID()
      await journal.recordUserInputWithId(editId, '重新编辑我', false)
      session.handleUserMessage('重新编辑我', false, [], editId)
      await journal.recordUserInputWithId(discardId, '丢弃我', false)
      session.handleUserMessage('丢弃我', false, [], discardId)

      assert.equal(await session.restoreQueuedMessage(editId), true)
      assert.equal(await session.discardQueuedMessage(discardId), true)
      assert.deepEqual(journal.pendingUserInputs.map(({ id, state }) => ({ id, state })), [
        { id: editId, state: 'restored' },
      ])
      assert.equal(events.some((event) =>
        event.type === 'queue-restored' && event.items?.[0]?.id === editId), true)
      assert.equal(events.some((event) =>
        event.type === 'message-dequeued' && event.id === discardId), true)

      session.abort()
      assert.equal(await running, 'aborted')
      const reopened = await store.open(journal.sessionId)
      assert.deepEqual(reopened.pendingUserInputs.map(({ id, state }) => ({ id, state })), [
        { id: editId, state: 'restored' },
      ])
    })
  })

  it('马上发送会复用 urgent steering 并中断当前模型步骤', async () => {
    await withImageSession(async ({ journal }) => {
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
          assert.match(JSON.stringify(options.prompt), /现在发送/)
          return finalStep('已处理插话。')
        },
      })
      const events: CoreEvent[] = []
      const session = createSession(model, journal, events)
      await journal.recordUserInput('开始', true)
      const running = session.handleUserMessage('开始')
      await firstStarted.promise
      const inputId = randomUUID()
      await journal.recordUserInputWithId(inputId, '现在发送', false)
      session.handleUserMessage('现在发送', false, [], inputId)

      assert.equal(session.sendQueuedMessageNow(inputId), true)
      assert.equal(await running, 'completed')
      assert.equal(call, 2)
      assert.equal(events.some((event) =>
        event.type === 'message-injected' && event.id === inputId), true)
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
