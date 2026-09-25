import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { ModelEntry } from '../providers/registry.ts'
import { ModelRequestError } from '../providers/model-request.ts'
import { SessionStore } from '../session/store.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'
import { localWorkspace } from '../workspace/types.ts'

const CURRENT_DATE_TEXT = '当前日期：'
const temporaryDirectories: string[] = []

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 25, 10).getTime() })
})

afterEach(async () => {
  mock.timers.reset()
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('Agent 当前日期上下文', () => {
  it('首步注入一次，同日工具执行数小时后仍复用提醒并完整持久化', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:current-date' })
    const model = new MockLanguageModelV4({ doStream: [toolStep(), finalStep()] })
    const session = createSession(model, journal)
    session.setExtraTools([dateProbe(() => {
      mock.timers.setTime(new Date(2026, 8, 25, 18).getTime())
    })])

    assert.equal(await session.handleUserMessage('查询当前状态'), 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(reminderCount(model.doStreamCalls[0]?.prompt), 1)
    assert.equal(reminderCount(model.doStreamCalls[1]?.prompt), 1)

    const firstPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
    assert.ok(firstPrompt.indexOf('查询当前状态') < firstPrompt.indexOf(CURRENT_DATE_TEXT))
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.ok(secondPrompt.indexOf(CURRENT_DATE_TEXT) < secondPrompt.indexOf('probe-ok'))

    const reopened = await store.open(journal.sessionId)
    assert.equal(reminderCount(reopened.initialMessages), 1)
    const userIndex = messageIndex(reopened.initialMessages, '查询当前状态')
    const reminderIndex = messageIndex(reopened.initialMessages, CURRENT_DATE_TEXT)
    const assistantIndex = reopened.initialMessages.findIndex((message) => message.role === 'assistant')
    assert.ok(userIndex >= 0 && userIndex < reminderIndex && reminderIndex < assistantIndex)
  })

  it('同一 turn 收到新的用户插话后，同日不重复追加日期', async () => {
    const firstCallStarted = createDeferred<void>()
    const releaseFirstCall = createDeferred<void>()
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls++
        if (calls === 1) {
          firstCallStarted.resolve()
          await releaseFirstCall.promise
          return toolStep()
        }
        return finalStep()
      },
    })
    const session = createSession(model)
    session.setExtraTools([dateProbe()])

    const running = session.handleUserMessage('先查询当前状态')
    await firstCallStarted.promise
    assert.equal(session.handleUserMessage('补充：也考虑最新变化'), undefined)
    releaseFirstCall.resolve()

    assert.equal(await running, 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(reminderCount(model.doStreamCalls[1]?.prompt), 1)
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.ok(secondPrompt.indexOf(CURRENT_DATE_TEXT) < secondPrompt.indexOf('补充：也考虑最新变化'))
  })

  it('中止的模型步骤不持久化孤立提醒，继续后只提交一次', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:current-date' })
    const modelCallStarted = createDeferred<void>()
    let calls = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (++calls > 1) return finalStep()
        modelCallStarted.resolve()
        return abortableStep(options.abortSignal)
      },
    })
    const session = createSession(model, journal)

    const running = session.handleUserMessage('开始一项查询')
    await modelCallStarted.promise
    session.abort()

    assert.equal(await running, 'aborted')
    assert.equal(reminderCount(model.doStreamCalls[0]?.prompt), 1)
    const reopened = await store.open(journal.sessionId)
    assert.equal(reminderCount(reopened.initialMessages), 0)
    assert.ok(messageIndex(reopened.initialMessages, '开始一项查询') >= 0)

    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(reminderCount(model.doStreamCalls[1]?.prompt), 1)
    assert.equal(reminderCount((await store.open(journal.sessionId)).initialMessages), 1)
  })

  it('同日多轮与冷恢复复用已提交日期，跨天重开才追加', async () => {
    const store = new SessionStore(await temporaryDirectory())
    const journal = await store.create({ workspace: localWorkspace(null), modelId: 'test:current-date' })
    const model = new MockLanguageModelV4({ doStream: async () => finalStep() })
    const session = createSession(model, journal)
    await session.handleUserMessage('第一轮')
    await session.handleUserMessage('第二轮')
    assert.equal(reminderCount(session.captureMessageSnapshot()), 1)

    const restored = createSession(model, await store.open(journal.sessionId))
    await restored.handleUserMessage('同日重新打开')
    assert.equal(reminderCount(model.doStreamCalls[2]?.prompt), 1)

    mock.timers.setTime(new Date(2026, 8, 26, 0, 0).getTime())
    const nextDay = createSession(model, await store.open(journal.sessionId))
    await nextDay.handleUserMessage('跨天重新打开')
    const prompt = JSON.stringify(model.doStreamCalls[3]?.prompt)
    assert.equal(reminderCount(prompt), 2)
    assert.ok(prompt.indexOf('跨天重新打开') < prompt.indexOf('当前日期：2026-09-26'))
    assert.equal(reminderCount((await store.open(journal.sessionId)).initialMessages), 2)
  })

  for (const phase of ['模型响应', '工具执行']) {
    it(`${phase}期间跨天，在工具结果之后的下一次正常请求补充日期`, async () => {
      const midnight = () => mock.timers.setTime(new Date(2026, 8, 26, 0, 0).getTime())
      let calls = 0
      const model = new MockLanguageModelV4({ doStream: async () => {
        if (++calls > 1) return finalStep()
        if (phase === '模型响应') midnight()
        return toolStep()
      } })
      const session = createSession(model)
      session.setExtraTools([dateProbe(() => { if (phase === '工具执行') midnight() })])
      assert.equal(await session.handleUserMessage('继续处理工具任务'), 'completed')
      assert.equal(model.doStreamCalls.length, 2)
      assert.equal(reminderCount(model.doStreamCalls[0]?.prompt), 1)
      const prompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
      assert.equal(reminderCount(prompt), 2)
      assert.ok(prompt.indexOf('probe-ok') < prompt.indexOf('当前日期：2026-09-26'))
      assert.equal(reminderCount(session.captureMessageSnapshot()), 2)
    })
  }

  for (const nextDay of [false, true]) {
    it(`失败重试不重复持久化提醒${nextDay ? '，跨天重试使用新日期' : ''}`, async () => {
      let calls = 0
      const model = new MockLanguageModelV4({ doStream: async () => {
        if (++calls > 1) return finalStep()
        if (nextDay) mock.timers.setTime(new Date(2026, 8, 26, 0, 0).getTime())
        throw new ModelRequestError('服务器暂时不可用', true, 0)
      } })
      const session = createSession(model)
      assert.equal(await session.handleUserMessage('查询'), 'completed')
      assert.equal(model.doStreamCalls.length, 2)
      assert.equal(reminderCount(model.doStreamCalls[1]?.prompt), 1)
      assert.equal(reminderCount(session.captureMessageSnapshot()), 1)
      if (nextDay) {
        assert.match(JSON.stringify(model.doStreamCalls[1]?.prompt), /当前日期：2026-09-26/u)
        assert.doesNotMatch(JSON.stringify(session.captureMessageSnapshot()), /当前日期：2026-09-25/u)
      } else {
        assert.deepEqual(model.doStreamCalls[1]?.prompt, model.doStreamCalls[0]?.prompt)
      }
    })
  }

  it('回滚快照保留提醒时复用，移除后重新补充', async () => {
    const model = new MockLanguageModelV4({ doStream: async () => finalStep() })
    const session = createSession(model)
    const beforeFirstTurn = session.captureMessageSnapshot()
    await session.handleUserMessage('第一轮')
    const afterFirstTurn = session.captureMessageSnapshot()
    await session.handleUserMessage('第二轮')

    session.restoreMessageSnapshot(afterFirstTurn)
    await session.handleUserMessage('重新处理第二轮')
    assert.equal(reminderCount(model.doStreamCalls[2]?.prompt), 1)

    session.restoreMessageSnapshot(beforeFirstTurn)
    await session.handleUserMessage('重新开始')
    assert.equal(reminderCount(model.doStreamCalls[3]?.prompt), 1)
    assert.equal(reminderCount(session.captureMessageSnapshot()), 1)
  })

  it('完整压缩移除日期提醒后，下一次请求按实际上下文重新注入', async () => {
    const model = new MockLanguageModelV4({
      doStream: [finalStep('x'.repeat(100_000)), finalStep()],
      doGenerate: async () => ({
        content: [{ type: 'text', text: '<summary>此前处理了用户请求。</summary>' }],
        finishReason: { unified: 'stop', raw: undefined }, usage: usage(), warnings: [],
      }),
    })
    const session = createSession(model)
    await session.handleUserMessage('生成长回复')
    await session.compactNow()
    assert.equal(model.doGenerateCalls.length, 1)
    assert.equal(reminderCount(session.captureMessageSnapshot()), 0)

    assert.equal(await session.handleUserMessage('压缩后继续'), 'completed')
    assert.equal(reminderCount(model.doStreamCalls[1]?.prompt), 1)
    assert.equal(reminderCount(session.captureMessageSnapshot()), 1)
  })

  it('token 基线覆盖已提交的日期提醒，但不误算宿主追加的工具结果', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep()] })
    const session = createSession(model)
    session.setExtraTools([dateProbe(undefined, true)])

    assert.equal(await session.handleUserMessage('执行后结束'), 'completed')

    const messages = session.captureMessageSnapshot()
    const firstToolResult = messages.findIndex((message) => message.role === 'tool')
    const baseline = (session as unknown as {
      tokenBaseline: { coveredMessageCount: number } | null
    }).tokenBaseline
    assert.ok(baseline)
    assert.equal(baseline.coveredMessageCount, firstToolResult)
    assert.equal(reminderCount(messages), 1)
  })
})

function dateProbe(onExecute?: () => void, endsTurnOnSuccess = false) {
  return buildTool({
    name: 'DateProbe',
    description: '日期上下文测试探针',
    prompt: '读取测试探针',
    inputSchema: z.object({}),
    isReadOnly: true,
    kind: 'read',
    endsTurnOnSuccess,
    async execute() {
      onExecute?.()
      return { data: 'probe-ok', isError: false }
    },
  })
}

function createSession(
  model: MockLanguageModelV4,
  recorder?: Awaited<ReturnType<SessionStore['create']>>,
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
    sessionRecorder: recorder,
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
  })
}

function toolStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: crypto.randomUUID(),
          toolName: 'DateProbe',
          input: '{}',
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: usage(),
        },
      ],
    }),
  }
}

function finalStep(text = '查询完成') {
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

function abortableStep(signal?: AbortSignal) {
  return {
    stream: new ReadableStream({
      start(controller) {
        const abort = () => controller.error(new Error('aborted'))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      },
    }),
  }
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:current-date',
    displayName: 'Current Date Mock',
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

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}

function reminderCount(value: unknown): number {
  return JSON.stringify(value).split(CURRENT_DATE_TEXT).length - 1
}

function messageIndex(messages: readonly unknown[], text: string): number {
  return messages.findIndex((message) => JSON.stringify(message).includes(text))
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-current-date-'))
  temporaryDirectories.push(path)
  return path
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
