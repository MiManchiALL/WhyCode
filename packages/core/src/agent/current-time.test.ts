import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

const CURRENT_TIME_TEXT = '当前本机时间：'
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  )
})

describe('Agent 当前时间上下文', () => {
  it('首步注入一次，短 turn 的工具续步复用同一条提醒并完整持久化', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:current-time' })
    const model = new MockLanguageModelV4({ doStream: [toolStep(), finalStep()] })
    const session = createSession(model, journal)
    session.setExtraTools([timeProbe()])

    assert.equal(await session.handleUserMessage('查询当前状态'), 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(reminderCount(model.doStreamCalls[0]?.prompt), 1)
    assert.equal(reminderCount(model.doStreamCalls[1]?.prompt), 1)

    const firstPrompt = JSON.stringify(model.doStreamCalls[0]?.prompt)
    assert.ok(firstPrompt.indexOf('查询当前状态') < firstPrompt.indexOf(CURRENT_TIME_TEXT))
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.ok(secondPrompt.indexOf(CURRENT_TIME_TEXT) < secondPrompt.indexOf('probe-ok'))

    const reopened = await store.open(journal.sessionId)
    assert.equal(reminderCount(reopened.initialMessages), 1)
    const userIndex = messageIndex(reopened.initialMessages, '查询当前状态')
    const reminderIndex = messageIndex(reopened.initialMessages, CURRENT_TIME_TEXT)
    const assistantIndex = reopened.initialMessages.findIndex((message) => message.role === 'assistant')
    assert.ok(userIndex >= 0 && userIndex < reminderIndex && reminderIndex < assistantIndex)
  })

  it('同一 turn 收到新的用户插话后，下一步立即追加新时间', async () => {
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
    const session = createMemorySession(model)
    session.setExtraTools([timeProbe()])

    const running = session.handleUserMessage('先查询当前状态')
    await firstCallStarted.promise
    assert.equal(session.handleUserMessage('补充：也考虑最新变化'), undefined)
    releaseFirstCall.resolve()

    assert.equal(await running, 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(reminderCount(model.doStreamCalls[1]?.prompt), 2)
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.ok(secondPrompt.lastIndexOf('补充：也考虑最新变化') < secondPrompt.lastIndexOf(CURRENT_TIME_TEXT))
  })

  it('中止的模型步骤不会留下孤立时间提醒', async () => {
    const root = await temporaryDirectory()
    const store = new SessionStore(root)
    const journal = await store.create({ projectDir: null, modelId: 'test:current-time' })
    const modelCallStarted = createDeferred<void>()
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
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
  })

  it('token 基线覆盖已提交的时间提醒，但不误算宿主追加的工具结果', async () => {
    const model = new MockLanguageModelV4({ doStream: [toolStep()] })
    const session = createMemorySession(model)
    session.setExtraTools([timeProbe(true)])

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

function timeProbe(endsTurnOnSuccess = false) {
  return buildTool({
    name: 'TimeProbe',
    description: '时间上下文测试探针',
    prompt: '读取测试探针',
    inputSchema: z.object({}),
    isReadOnly: true,
    kind: 'read',
    availableWithoutProject: true,
    endsTurnOnSuccess,
    async execute() {
      return { data: 'probe-ok', isError: false }
    },
  })
}

function createSession(
  model: MockLanguageModelV4,
  recorder: Awaited<ReturnType<SessionStore['create']>>,
): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: null, osPlatform: 'win32' },
    sessionRecorder: recorder,
    emit: () => {},
    requestApproval: async () => ({ approved: false }),
  })
}

function createMemorySession(model: MockLanguageModelV4): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: null, osPlatform: 'win32' },
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
          toolName: 'TimeProbe',
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

function finalStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: '查询完成' },
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
    id: 'test:current-time',
    displayName: 'Current Time Mock',
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
  return JSON.stringify(value).split(CURRENT_TIME_TEXT).length - 1
}

function messageIndex(messages: readonly unknown[], text: string): number {
  return messages.findIndex((message) => JSON.stringify(message).includes(text))
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'whycode-current-time-'))
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
