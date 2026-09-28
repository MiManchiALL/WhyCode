import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'node:test'
import {
  AgentSession,
  SessionStore,
  SkillCatalogService,
  SubagentDefinitionCatalogService,
  createWebSearchTool,
  localWorkspace,
  type ModelEntry,
  type SubagentModelSnapshot,
  type SubagentSettlementNotification,
} from '@whycode/core'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { HostOperationScheduler } from './host-operation-scheduler.ts'
import { SessionScratchManager } from './session-scratch.ts'
import { SubagentService, type SubagentServiceOptions } from './subagent-service.ts'

type ModelCall = Parameters<Extract<ReturnType<ModelEntry['create']>, { specificationVersion: 'v4' }>['doStream']>[0]
interface FixtureOptions extends Partial<Pick<SubagentServiceOptions,
  'pdfProcessor' | 'officeProcessor' | 'captureScreenshot' | 'createWebPageTools'>> {
  supportsImageInput?: boolean
  parentSupportsImageInput?: boolean
}

const roots: string[] = []
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

export async function createFixture(
  responses: string[],
  responseForCall?: (index: number, options: ModelCall) => Promise<unknown>,
  selectModel: (parent: SubagentModelSnapshot) => SubagentModelSnapshot | null =
    (parent) => parent,
  options: FixtureOptions = {},
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
  const modelCalls: ModelCall[] = []
  let responseIndex = 0
  const model = languageModel(async (options) => {
    modelCalls.push(options)
    const index = responseIndex++
    return responseForCall?.(index, options) ?? finalStream(responses[index] ?? '完成。')
  })
  const entry = modelEntry(model, options.supportsImageInput)
  const runtime = new DesktopSessionRuntime({
    workspace: localWorkspace(projectDir),
    modelId: entry.id,
    emit: () => undefined,
  })
  runtime.journal = parentJournal
  runtime.session = new AgentSession({
    model: modelEntry(model, options.parentSupportsImageInput),
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
  const resolvedModelIds: string[] = []
  const serviceOptions: SubagentServiceOptions = {
    sessionsRoot,
    scratch,
    definitions: new SubagentDefinitionCatalogService({ homeDir: root }),
    skills: new SkillCatalogService({ homeDir: root }),
    webSearchTool: createWebSearchTool({ search: async () => ({ results: [] }) }),
    createWebPageTools: options.createWebPageTools ?? (() => []),
    selectModel,
    resolveModel: (modelId) => {
      resolvedModelIds.push(modelId)
      return { entry, providerConfig: { apiKey: 'test' } }
    },
    pdfProcessor: options.pdfProcessor ?? {
      inspect: async () => { throw new Error('unexpected PDF inspect') },
      readPages: async () => { throw new Error('unexpected PDF read') },
    },
    officeProcessor: options.officeProcessor ?? {
      inspect: async () => { throw new Error('unexpected Office inspect') },
      renderPages: async () => { throw new Error('unexpected Office render') },
    },
    captureScreenshot: options.captureScreenshot ?? (async () => { throw new Error('unexpected screenshot') }),
    hostOperations: new HostOperationScheduler(),
    onState: () => undefined,
    onEvent: () => undefined,
    onSettlement: (notification) => settlements.push(notification),
    onParentIdle: () => undefined,
  }
  const service = new SubagentService(serviceOptions)
  cleanups.push(async () => {
    await service.close()
    await runtime.session?.dispose()
  })
  return {
    service,
    serviceOptions,
    runtime,
    parentJournal,
    projectDir,
    sessionsRoot,
    settlements,
    modelCalls,
    resolvedModelIds,
  }
}

export function languageModel(doStream: (options: ModelCall) => Promise<unknown>) {
  return {
    specificationVersion: 'v4' as const,
    provider: 'test',
    modelId: 'subagent-test',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('测试不使用 generate') },
    doStream,
  } as ReturnType<ModelEntry['create']>
}

export function modelEntry(model: ReturnType<ModelEntry['create']>, supportsImageInput = false): ModelEntry {
  return {
    id: 'test:subagent',
    displayName: 'Subagent Test',
    provider: 'openai',
    protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true,
      supportsImageInput,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

export function finalStream(text: string) {
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

export function listDirStream(index: number) {
  return toolStream('ListDir', { path: '.', limit: 1, offset: index }, `list-${index}`)
}

export function toolStream(toolName: string, input: unknown, toolCallId = 'doc-tool') {
  return Promise.resolve({
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({
          type: 'tool-call' as const,
          toolCallId,
          toolName,
          input: JSON.stringify(input),
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

export function toolContext(turnId: string, toolCallId: string) {
  return {
    projectDir: 'C:\workspace',
    additionalDirs: [],
    abortSignal: new AbortController().signal,
    turnId,
    toolCallId,
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待子代理终态超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}
