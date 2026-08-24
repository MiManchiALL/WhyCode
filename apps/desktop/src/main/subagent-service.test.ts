import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  AgentSession,
  SessionStore,
  SkillCatalogService,
  SubagentDefinitionCatalogService,
  createWebSearchTool,
  localWorkspace,
  type ModelEntry,
  type SubagentSettlementNotification,
} from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { HostOperationScheduler } from './host-operation-scheduler.ts'
import { SessionScratchManager } from './session-scratch.ts'
import { SubagentService } from './subagent-service.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('子代理激活生命周期', () => {
  it('冷启动独立 transcript，结束即释放，并可用同一稳定 ID 继续', async () => {
    const fixture = await createFixture(['第一次调查完成。', '补充调查完成。'])
    const tools = fixture.service.createTools(
      fixture.runtime,
      fixture.parentJournal,
      fixture.projectDir,
    )

    const launched = await tools[0]!.execute(
      { agent_id: 'explore', description: '核对调用链', prompt: '检查调用链并给出证据' },
      toolContext('turn-1', 'tool-1'),
    )
    assert.equal(launched.isError, false)
    const subagentId = launched.data.match(/[0-9a-f-]{36}/u)?.[0]
    assert.ok(subagentId)
    await waitFor(() => fixture.settlements.length === 1)

    assert.equal(fixture.runtime.busy, false)
    assert.equal(fixture.settlements[0]?.outcome, 'completed')
    assert.equal(fixture.settlements[0]?.parentTurnId, 'turn-1')
    assert.equal(fixture.settlements[0]?.resultText, '第一次调查完成。')
    const pendingTurnState = await fixture.service.turnState(
      fixture.parentJournal.sessionId,
      'turn-1',
    )
    assert.equal(pendingTurnState.activations[0]?.outcome, 'completed')
    assert.equal(pendingTurnState.activations[0]?.settlement, 'pending')
    await fixture.service.markSettlementDelivered(fixture.settlements[0]!)
    const deliveredTurnState = await fixture.service.turnState(
      fixture.parentJournal.sessionId,
      'turn-1',
    )
    assert.equal(deliveredTurnState.activations[0]?.settlement, 'delivered')
    const firstState = await fixture.service.state(fixture.parentJournal.sessionId)
    assert.equal(firstState.subagents[0]?.id, subagentId)
    assert.equal(firstState.subagents[0]?.activationCount, 1)
    assert.equal(firstState.subagents[0]?.status, 'completed')
    assert.equal(firstState.subagents[0]?.description, '核对调用链')
    const listed = await tools[2]!.execute({}, toolContext('turn-list', 'tool-list'))
    assert.equal(listed.isError, false)
    assert.deepEqual(JSON.parse(listed.data).subagents, [{
      agent_id: 'explore',
      subagent_id: subagentId,
      description: '核对调用链',
      status: 'completed',
    }])

    const continuations = await Promise.all([
      tools[1]!.execute(
        { subagent_id: subagentId, prompt: '继续核对遗漏的边界' },
        toolContext('turn-2', 'tool-2'),
      ),
      tools[1]!.execute(
        { subagent_id: subagentId, prompt: '继核对同一个遗漏边界' },
        toolContext('turn-3', 'tool-3'),
      ),
    ])
    const continued = continuations.find((result) => !result.isError)
    const rejected = continuations.find((result) => result.isError)
    assert.ok(continued)
    assert.ok(rejected)
    assert.equal(continued.isError, false)
    assert.match(continued.data, new RegExp(subagentId, 'u'))
    assert.match(rejected.data, /仍在运行/)
    await waitFor(() => fixture.settlements.length === 2)

    const snapshot = await fixture.service.transcript(
      fixture.parentJournal.sessionId,
      subagentId,
    )
    assert.equal(snapshot.subagent.activationCount, 2)
    assert.equal(snapshot.subagent.status, 'completed')
    const finishedDurations = snapshot.viewEvents.flatMap((event) =>
      event.type === 'core-event' && event.event.type === 'work-finished'
        ? [event.event.durationMs]
        : [])
    assert.equal(finishedDurations.length, 2)
    assert.equal(
      snapshot.subagent.completedDurationMs,
      finishedDurations.reduce((total, duration) => total + duration, 0),
    )
    const rapidSnapshots = await Promise.all(Array.from({ length: 12 }, () =>
      fixture.service.transcript(fixture.parentJournal.sessionId, subagentId)))
    assert.deepEqual(
      rapidSnapshots.map((item) => item.viewEvents),
      Array.from({ length: 12 }, () => snapshot.viewEvents),
    )
    const transcript = await readFile(join(
      fixture.sessionsRoot,
      fixture.parentJournal.sessionId,
      'subagents',
      subagentId,
      'transcript.jsonl',
    ), 'utf8')
    assert.match(transcript, /检查调用链并给出证据/)
    assert.match(transcript, /第一次调查完成。/)
    assert.match(transcript, /继续核对遗漏的边界/)
    assert.match(transcript, /补充调查完成。/)
    assert.doesNotMatch(transcript, /父会话普通历史/)

    const request = JSON.stringify(fixture.modelCalls[0])
    assert.match(request, /子代理身份：探索代理/)
    assert.match(request, /CreateTaskPlan/)
    assert.match(request, /ReadFile/)
    assert.doesNotMatch(request, /AskUserQuestion/)
    assert.doesNotMatch(request, /RunCommand/)
    assert.doesNotMatch(request, /SendSubagentMessage/)
    await fixture.service.close()
  })

  it('每个父会话最多并发八个激活，但不占用户会话运行名额', async () => {
    const fixture = await createFixture(Array.from({ length: 8 }, (_, index) => `结果 ${index + 1}`))
    const tools = fixture.service.createTools(
      fixture.runtime,
      fixture.parentJournal,
      fixture.projectDir,
    )
    const results = await Promise.all(Array.from({ length: 9 }, (_, index) =>
      tools[0]!.execute(
        { agent_id: 'explore', description: `并行调查 ${index + 1}`, prompt: `并行调查 ${index + 1}` },
        toolContext(`turn-${index}`, `tool-${index}`),
      )))

    assert.equal(results.filter((result) => !result.isError).length, 8)
    assert.equal(results.filter((result) => result.isError).length, 1)
    assert.match(results.find((result) => result.isError)?.data ?? '', /8 个/)
    assert.equal(fixture.runtime.userRunBusy, false)
    await waitFor(() => fixture.settlements.length === 8)
    assert.equal(fixture.runtime.busy, false)
    await fixture.service.close()
  })

  it('单次激活超过八十个模型步骤后仍由模型自然结束', async () => {
    const fixture = await createFixture([], (index) =>
      index < 81 ? listDirStream(index) : finalStream('长任务自然完成。'))
    const tools = fixture.service.createTools(
      fixture.runtime,
      fixture.parentJournal,
      fixture.projectDir,
    )

    const launched = await tools[0]!.execute(
      { agent_id: 'explore', description: '持续检查证据', prompt: '持续检查直到证据充分' },
      toolContext('turn-long', 'tool-long'),
    )

    assert.equal(launched.isError, false)
    await waitFor(() => fixture.settlements.length === 1, 15_000)
    assert.equal(fixture.modelCalls.length, 82)
    assert.equal(fixture.settlements[0]?.outcome, 'completed')
    assert.equal(fixture.settlements[0]?.resultText, '长任务自然完成。')
    await fixture.service.close()
  })

  it('父会话停止会取消激活并确认终态，但不再触发自动续轮', async () => {
    const started = deferred<void>()
    const release = deferred<void>()
    const fixture = await createFixture([], async () => {
      started.resolve()
      await release.promise
      return finalStream('不应交付的取消后结果。')
    })
    const tools = fixture.service.createTools(
      fixture.runtime,
      fixture.parentJournal,
      fixture.projectDir,
    )
    const launched = await tools[0]!.execute(
      { agent_id: 'explore', description: '等待停止验证', prompt: '等待父会话停止' },
      toolContext('turn-stop', 'tool-stop'),
    )
    assert.equal(launched.isError, false)
    await started.promise

    const aborting = fixture.service.beginParentAbort(fixture.parentJournal.sessionId)
    assert.deepEqual(aborting.interruptedSubagents, [{
      subagentId: launched.data.match(/[0-9a-f-]{36}/u)?.[0],
      description: '等待停止验证',
    }])
    release.resolve()
    await aborting.done

    assert.equal(fixture.settlements.length, 0)
    const state = await fixture.service.turnState(
      fixture.parentJournal.sessionId,
      'turn-stop',
    )
    assert.equal(state.activations[0]?.outcome, 'aborted')
    assert.equal(state.activations[0]?.settlement, 'delivered')
    await fixture.service.close()
  })
})

async function createFixture(
  responses: string[],
  responseForCall?: (index: number) => Promise<unknown>,
) {
  const root = await mkdtemp(join(tmpdir(), 'whycode-subagent-service-'))
  roots.push(root)
  const sessionsRoot = join(root, 'sessions')
  const scratchRoot = join(root, 'scratch')
  const projectDir = join(root, 'project')
  await mkdir(projectDir, { recursive: true })
  const parentJournal = await new SessionStore(sessionsRoot).create({
    workspace: localWorkspace(projectDir),
    modelId: 'test:subagent',
  })
  const scratch = new SessionScratchManager(scratchRoot)
  const parentScratch = await scratch.ensure(parentJournal.sessionId)
  const modelCalls: unknown[] = []
  let responseIndex = 0
  const model = languageModel(async (options) => {
    modelCalls.push(options)
    const index = responseIndex++
    return responseForCall?.(index) ?? finalStream(responses[index] ?? '完成。')
  })
  const entry = modelEntry(model)
  const runtime = new DesktopSessionRuntime({
    workspace: localWorkspace(projectDir),
    modelId: entry.id,
    emit: () => undefined,
  })
  runtime.journal = parentJournal
  runtime.session = new AgentSession({
    model: entry,
    providerConfig: { apiKey: 'test' },
    promptContext: {
      projectDir,
      osPlatform: 'win32',
      scratch: {
        rootDir: parentScratch.rootDirectory,
        workingDir: parentScratch.mainDirectory,
      },
    },
    sessionRecorder: parentJournal,
    emit: () => undefined,
    requestApproval: async () => ({ approved: false }),
  })
  const settlements: SubagentSettlementNotification[] = []
  const service = new SubagentService({
    sessionsRoot,
    scratch,
    definitions: new SubagentDefinitionCatalogService({ homeDir: root }),
    skills: new SkillCatalogService({ homeDir: root }),
    webSearchTool: createWebSearchTool({ search: async () => ({ results: [] }) }),
    createWebPageTools: () => [],
    resolveModel: () => ({ entry, providerConfig: { apiKey: 'test' } }),
    auxiliaryImageAnalyzer: () => undefined,
    hostOperations: new HostOperationScheduler(),
    onState: () => undefined,
    onEvent: () => undefined,
    onSettlement: (notification) => settlements.push(notification),
    onParentIdle: () => undefined,
  })
  return {
    service,
    runtime,
    parentJournal,
    projectDir,
    sessionsRoot,
    settlements,
    modelCalls,
  }
}

function languageModel(doStream: (options: unknown) => Promise<unknown>) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'test',
    modelId: 'subagent-test',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('测试不使用 generate') },
    doStream,
  } as ReturnType<ModelEntry['create']>
}

function modelEntry(model: ReturnType<ModelEntry['create']>): ModelEntry {
  return {
    id: 'test:subagent',
    displayName: 'Subagent Test',
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

function finalStream(text: string) {
  return Promise.resolve({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-start', id: 'answer' })
        controller.enqueue({ type: 'text-delta', id: 'answer', delta: text })
        controller.enqueue({ type: 'text-end', id: 'answer' })
        controller.enqueue({
          type: 'finish',
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
        })
        controller.close()
      },
    }),
  })
}

function listDirStream(index: number) {
  return Promise.resolve({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-call' as const,
          toolCallId: `list-${index}`,
          toolName: 'ListDir',
          input: JSON.stringify({ path: '.', limit: 1, offset: index }),
        })
        controller.enqueue({
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
        })
        controller.close()
      },
    }),
  })
}

function toolContext(turnId: string, toolCallId: string) {
  return {
    projectDir: 'C:\workspace',
    additionalDirs: [],
    abortSignal: new AbortController().signal,
    turnId,
    toolCallId,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待子代理终态超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
