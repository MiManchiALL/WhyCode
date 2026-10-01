import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import { autoCompactThreshold } from '../context/tokens.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

const capacityError = '当前上下文超过目标模型的可用容量，请先在当前模型下压缩后再尝试切换，或新建会话。'

describe('模型切换的上下文容量', () => {
  it('700k 历史拒绝切到 256k，保留选择、正文和用量；用户在原模型压缩后可重试', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-model-capacity-'))
    try {
      const large = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [{ type: 'text', text: '<summary>已完成前面的长任务，继续处理后续请求。</summary>' }],
          finishReason: { unified: 'stop', raw: undefined }, usage: usage(), warnings: [],
        }),
      })
      const small = new MockLanguageModelV4({ doStream: [textStep('继续处理')] })
      const current = modelEntry('test:large', large, 1_000_000)
      current.capabilities.reasoningEffort = { supported: ['high'], default: 'high' }
      const target = modelEntry('test:small', small, 256_000)
      const store = new SessionStore(root)
      const journal = await store.create({ workspace: localWorkspace(root), modelId: current.id, reasoningEffort: 'high' })
      const messages: ModelMessage[] = Array.from({ length: 35 }, () => [
        { role: 'user' as const, content: 'x'.repeat(40_000) },
        { role: 'assistant' as const, content: 'y'.repeat(40_000) },
      ]).flat()
      await journal.recordSnapshot('compact', messages)
      const events: CoreEvent[] = []
      const session = new AgentSession({
        model: current, providerConfig: { apiKey: 'large' }, reasoningEffort: 'high',
        promptContext: { projectDir: root, osPlatform: process.platform },
        sessionRecorder: journal,
        emit: event => events.push(event), requestApproval: async () => ({ approved: false }),
      })
      await session.initializeContextUsage()
      const before = session.captureMessageSnapshot()
      const beforeEvents = events.length

      await assert.rejects(session.setModelSelection(target, { apiKey: 'small' }, 'default'), { message: capacityError })
      assert.equal(journal.metadataSnapshot.modelId, current.id)
      assert.equal(journal.metadataSnapshot.reasoningEffort, 'high')
      assert.equal((await store.open(journal.sessionId)).metadataSnapshot.modelId, current.id)
      assert.deepEqual(session.captureMessageSnapshot(), before)
      assert.equal(events.length, beforeEvents)
      assert.equal(large.doGenerateCalls.length, 0)
      assert.equal(small.doStreamCalls.length, 0)

      await session.compactNow()
      assert.equal(large.doGenerateCalls.length, 1, JSON.stringify(events.filter(event => event.type === 'error')))
      assert.equal(small.doGenerateCalls.length, 0)
      assert.ok(events.some(event => event.type === 'context-compacted'))
      await session.setModelSelection(target, { apiKey: 'small' }, 'default')
      assert.equal(journal.metadataSnapshot.modelId, target.id)
      assert.equal(journal.metadataSnapshot.reasoningEffort, 'default')
      assert.equal(await session.handleUserMessage('压缩后继续'), 'completed')
      assert.equal(small.doStreamCalls.length, 1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('按 Provider 真实 usage 和目标可用预算拦截，同模型更新不被拦截，扩容仍可切换', async () => {
    const currentModel = new MockLanguageModelV4({ doStream: [textStep('简短回复', 235_000)] })
    const current = modelEntry('test:large', currentModel, 1_000_000)
    const events: CoreEvent[] = []
    const session = new AgentSession({
      model: current, providerConfig: { apiKey: 'large' },
      promptContext: { projectDir: process.cwd(), osPlatform: process.platform },
      emit: event => events.push(event), requestApproval: async () => ({ approved: false }),
    })
    assert.equal(await session.handleUserMessage('带有较大 Provider 用量的短消息'), 'completed')
    const target = modelEntry('test:small', new MockLanguageModelV4(), 256_000)
    const lastUsage = events.filter(event => event.type === 'context-usage').at(-1)?.usage
    assert.ok(lastUsage && lastUsage.usedTokens > autoCompactThreshold(target.capabilities))
    assert.ok(lastUsage.usedTokens < target.capabilities.contextWindow)
    const beforeEvents = events.length
    await assert.rejects(session.setModelSelection(target, { apiKey: 'small' }, 'default'), { message: capacityError })
    assert.equal(events.length, beforeEvents)
    await session.setModelSelection(current, { apiKey: 'updated' }, 'default')
    await session.setModelSelection(modelEntry('test:larger', new MockLanguageModelV4(), 2_000_000), { apiKey: 'larger' }, 'default')
    assert.equal(events.filter(event => event.type === 'context-usage').at(-1)?.usage?.contextWindow, 2_000_000)
  })

  it('历史较短时允许切换到更小窗口，未初始化用量也计入 System 与工具开销', async () => {
    const target = modelEntry('test:small', new MockLanguageModelV4(), 64_000)
    const session = new AgentSession({
      model: modelEntry('test:large', new MockLanguageModelV4(), 1_000_000),
      providerConfig: { apiKey: 'large' },
      promptContext: { projectDir: process.cwd(), osPlatform: process.platform },
      emit: () => {}, requestApproval: async () => ({ approved: false }),
    })
    session.restoreMessageSnapshot([{ role: 'user', content: 'x'.repeat((autoCompactThreshold(target.capabilities) - 10) * 4) }])
    await assert.rejects(session.setModelSelection(target, { apiKey: 'small' }, 'default'), { message: capacityError })
    session.restoreMessageSnapshot([{ role: 'user', content: '简短历史' }, { role: 'assistant', content: '收到' }])
    await session.setModelSelection(target, { apiKey: 'small' }, 'default')
  })
})

describe('运行中模型选择', () => {
  it('当前 turn 固化原模型，运行中选择的新模型从下一 turn 生效', async () => {
    const events: CoreEvent[] = []
    const nextModel = new MockLanguageModelV4({
      doStream: [textStep('下一回合')],
    })
    const nextEntry = modelEntry('test:next-model', nextModel, 200_000)
    let session!: AgentSession
    const switchModel = buildTool({
      name: 'SwitchModelProbe',
      description: '在模型步骤之间切换会话默认模型',
      prompt: '调用模型切换探针',
      inputSchema: z.object({}),
      isReadOnly: true,
      kind: 'control',
      async execute() {
        await session.setModelSelection(nextEntry, { apiKey: 'next' }, 'default')
        return { data: 'switched', isError: false }
      },
    })
    const currentModel = new MockLanguageModelV4({
      doStream: [toolStep('SwitchModelProbe'), textStep('当前回合')],
    })
    session = new AgentSession({
      model: modelEntry('test:current-model', currentModel),
      providerConfig: { apiKey: 'current' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([switchModel])

    assert.equal(await session.handleUserMessage('开始'), 'completed')
    assert.equal(currentModel.doStreamCalls.length, 2)
    assert.equal(nextModel.doStreamCalls.length, 0)
    const switchedUsage = events.filter((event) => event.type === 'context-usage').at(-1)
    assert.equal(
      switchedUsage?.type === 'context-usage' && switchedUsage.usage?.contextWindow,
      200_000,
    )

    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(currentModel.doStreamCalls.length, 2)
    assert.equal(nextModel.doStreamCalls.length, 1)
  })

  it('同一 AgentSession 固定传输身份，不同会话绝不复用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-model-session-'))
    try {
      const journal = await new SessionStore(root).create({
        workspace: localWorkspace(null),
        modelId: 'test:persisted',
      })
      const persistedIds: string[] = []
      const persistedModel = new MockLanguageModelV4({
        doStream: [textStep('第一轮'), textStep('第二轮')],
      })
      const persisted = new AgentSession({
        model: modelEntry('test:persisted', persistedModel, 100_000, (id) => {
          persistedIds.push(id ?? '')
        }),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
        sessionRecorder: journal,
      })
      await persisted.handleUserMessage('第一轮')
      await persisted.handleUserMessage('第二轮')
      assert.deepEqual(persistedIds, [journal.sessionId, journal.sessionId])

      const memoryIds: string[] = []
      for (let index = 0; index < 2; index++) {
        const model = new MockLanguageModelV4({ doStream: [textStep(`内存 ${index}`)] })
        const session = new AgentSession({
          model: modelEntry(`test:memory-${index}`, model, 100_000, (id) => {
            memoryIds.push(id ?? '')
          }),
          providerConfig: { apiKey: 'test' },
          promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
          emit: () => {},
          requestApproval: async () => ({ approved: false }),
        })
        await session.handleUserMessage(`内存 ${index}`)
      }
      assert.equal(memoryIds.length, 2)
      assert.notEqual(memoryIds[0], memoryIds[1])
      assert.match(memoryIds[0]!, /^[0-9a-f-]{36}$/)
      assert.match(memoryIds[1]!, /^[0-9a-f-]{36}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function toolStep(toolName: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'switch-model',
          toolName,
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

function textStep(text: string, inputTokens = 10) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: text },
        { type: 'text-end' as const, id: 'answer' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: usage(inputTokens),
        },
      ],
    }),
  }
}

function modelEntry(
  id: string,
  model: MockLanguageModelV4,
  contextWindow = 100_000,
  onCreate?: (transportSessionId: string | undefined) => void,
): ModelEntry {
  return {
    id,
    displayName: id,
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput: false,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow,
      maxOutput: 4_000,
    },
    create: (_config, options) => {
      onCreate?.(options?.transportSessionId)
      return model
    },
  }
}

function usage(inputTokens = 10) {
  return {
    inputTokens: { total: inputTokens, noCache: inputTokens, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
