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
      { agent_id: 'explore', prompt: '检查调用链并给出证据' },
      toolContext('turn-1', 'tool-1'),
    )
    assert.equal(launched.isError, false)
    const subagentId = launched.data.match(/[0-9a-f-]{36}/u)?.[0]
    assert.ok(subagentId)
    await waitFor(() => fixture.settlements.length === 1)

    assert.equal(fixture.runtime.busy, false)
    assert.equal(fixture.settlements[0]?.outcome, 'completed')
    assert.equal(fixture.settlements[0]?.resultText, '第一次调查完成。')
    const firstState = await fixture.service.state(fixture.parentJournal.sessionId)
    assert.equal(firstState.subagents[0]?.id, subagentId)
    assert.equal(firstState.subagents[0]?.activationCount, 1)
    assert.equal(firstState.subagents[0]?.status, 'completed')

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
    assert.doesNotMatch(request, /StartCommand/)
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
        { agent_id: 'explore', prompt: `并行调查 ${index + 1}` },
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
})

async function createFixture(responses: string[]) {
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
    return finalStream(responses[responseIndex++] ?? '完成。')
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

function toolContext(turnId: string, toolCallId: string) {
  return {
    projectDir: 'C:\workspace',
    additionalDirs: [],
    abortSignal: new AbortController().signal,
    turnId,
    toolCallId,
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待子代理终态超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
