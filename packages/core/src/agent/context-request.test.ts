import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { estimateMessageTokens } from '../context/tokens.ts'
import type { ContextUsageInfo, CoreEvent } from '../events.ts'
import { loadMcpConfiguration, MCP_CONFIG_VERSION } from '../mcp/config.ts'
import { McpSessionRuntime } from '../mcp/runtime.ts'
import type { PdfProcessor } from '../pdf/processor.ts'
import { preparePdfAttachmentImport } from '../pdf/storage.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession, type AgentSessionOptions } from './session.ts'

describe('最终请求的压缩计量', () => {
  it('日期提醒越过边界时先压缩，界面总量就是判断值', async (t) => {
    const { session, events, entry, model } = await fixture(t)
    await session.initializeContextUsage()
    const before = latestUsage(events)
    const input = '继续'
    entry.capabilities.contextWindow = before.usedTokens
      + estimateMessageTokens({ role: 'user', content: input }) + 17_001
    assert.equal(await session.handleUserMessage(input), 'completed')
    assert.equal(model.doGenerateCalls.length, 1)
    assertCompactionMatchesUsage(events)
    assert.match(JSON.stringify(model.doStreamCalls[0]!.prompt), /当前日期/)
  })

  it('本步新读到的子代理状态在请求前计入压缩边界', async (t) => {
    const { session, events, entry, model } = await fixture(t, {
      getSubagentTurnState: async parentTurnId => ({
        parentTurnId,
        activations: Array.from({ length: 12 }, (_, index) => ({
          subagentId: randomUUID(), activationId: randomUUID(), name: `子代理 ${index}`,
          description: '已完成状态检查', sequence: 1, outcome: 'completed', settlement: 'delivered',
        })),
      }),
    })
    await session.initializeContextUsage()
    entry.capabilities.contextWindow = latestUsage(events).usedTokens + 17_500
    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(model.doGenerateCalls.length, 1)
    assertCompactionMatchesUsage(events)
    assert.match(JSON.stringify(model.doStreamCalls[0]!.prompt), /whycode-subagent-turn-state/)
  })

  it('冷恢复的 MCP schema 解析后即计入判断，压缩不丢失工具', async (t) => {
    const { root, options, entry, model, events } = await fixture(t)
    const path = join(root, 'mcp.json')
    await writeFile(path, JSON.stringify({ version: MCP_CONFIG_VERSION, servers: {
      probe: { transport: 'http', url: 'https://probe.example.test/mcp' },
    } }))
    const configuration = await loadMcpConfiguration({ globalConfigPath: path })
    assert.deepEqual(configuration.diagnostics, [])
    const runtime = new McpSessionRuntime({ configuration, fetchImpl: mcpFetch })
    t.after(() => runtime.close())
    const binding = await runtime.beginStep([], new AbortController().signal)
    const result = await binding.toolDefinitions()[0]!.execute({ query: 'probe', max_results: 1 }, {
      projectDir: root, additionalDirs: [], abortSignal: new AbortController().signal,
    })
    assert.equal(result.isError, false)
    const state = binding.messagesOnCommit()
    await runtime.close()
    const restoredRuntime = new McpSessionRuntime({ configuration, fetchImpl: mcpFetch })
    const restored = new AgentSession({ ...options, mcpRuntime: restoredRuntime })
    t.after(() => restored.dispose())
    restored.restoreMessageSnapshot([...history(), ...state])
    await restored.initializeContextUsage()
    const cold = latestUsage(events)
    entry.capabilities.contextWindow = cold.usedTokens + 17_300
    assert.equal(await restored.handleUserMessage('继续'), 'completed')
    assert.equal(model.doGenerateCalls.length, 1)
    assert.ok(latestUsage(events).breakdown.toolTokens > cold.breakdown.toolTokens + 1_000)
    assert.ok(model.doStreamCalls[0]!.tools?.some(tool => tool.name.includes('__probe__')))
    assertCompactionMatchesUsage(events)
  })

  it('小 PDF 展开后触发压缩，同一附件在 Provider 基线之后不重复计费', async (t) => {
    let renders = 0
    const processor: PdfProcessor = {
      inspect: async () => ({ pageCount: 2, byteLength: 9 }),
      readPages: async (_path, options) => {
        assert.equal(options.mode, 'visual')
        if (options.mode !== 'visual') throw new Error('expected visual pages')
        renders++
        const renderedPages = []
        for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
          const path = join(options.outputDirectory, `${pageNumber}.jpg`)
          await writeFile(path, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]))
          renderedPages.push({ pageNumber, path, width: 1, height: 1 })
        }
        return { mode: 'visual', pageCount: 2, renderedPages }
      },
    }
    const { root, session, options, entry, model, events } = await fixture(t, { pdfProcessor: processor })
    assert.equal(await session.handleUserMessage('建立用量基线'), 'completed')
    entry.capabilities.contextWindow = 79_000 // 阈值 62k，新增两页图片跨过边界。
    const source = join(root, 'sample.pdf')
    await writeFile(source, '%PDF-1.4\n')
    const imported = await preparePdfAttachmentImport(
      [{ kind: 'path', path: source }], options.sessionRecorder.attachmentDirectory,
      options.sessionRecorder.sessionId, processor, new AbortController().signal,
    )
    await imported.commit()
    assert.equal(await session.handleUserMessage('阅读附件', false, [], undefined, imported.attachments), 'completed')
    assert.equal(model.doGenerateCalls.length, 1)
    assertCompactionMatchesUsage(events)
    assert.match(JSON.stringify(model.doStreamCalls[1]!.prompt), /whycode-pdf-inline/)
    const after = latestUsage(events)
    let nextRequest: ContextUsageInfo | undefined
    model.doStream = async () => { nextRequest = latestUsage(events); return finalStep() }
    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(model.doGenerateCalls.length, 1, '已被 Provider usage 覆盖的页面不能再次推过阈值')
    assert.equal(nextRequest?.usedTokens, after.usedTokens + estimateMessageTokens({ role: 'user', content: '继续' }))
    assert.equal(renders, 1, '重新装配复用现有 PDF 页缓存')
  })

  it('压缩快照保存失败时不发送普通请求', async (t) => {
    const { session, entry, options, model, events } = await fixture(t)
    await session.initializeContextUsage()
    entry.capabilities.contextWindow = latestUsage(events).usedTokens + 17_001
    options.sessionRecorder.recordSnapshot = async () => { throw new Error('快照写入失败') }
    assert.equal(await session.handleUserMessage('继续'), 'error')
    assert.equal(model.doStreamCalls.length, 0)
    assert.match(events.findLast(event => event.type === 'error')?.message ?? '', /快照写入失败/)
  })
})

function assertCompactionMatchesUsage(events: CoreEvent[]) {
  const index = events.findIndex(event => event.type === 'context-compacted')
  const compacted = events[index]
  assert.ok(compacted?.type === 'context-compacted')
  const before = latestUsage(events.slice(0, index))
  assert.equal(compacted.preTokens, before.usedTokens)
  assert.ok(before.usedTokens >= before.autoCompactThreshold)
  const next = events.slice(index + 1).find(event => event.type === 'context-usage')
  assert.ok(next?.type === 'context-usage' && next.usage)
  assert.equal(compacted.postTokens, next.usage.usedTokens)
  assert.ok(compacted.postTokens < compacted.preTokens)
}

async function fixture(t: TestContext, overrides: Partial<AgentSessionOptions> = {}) {
  const temporaryDirectory = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryDirectory, 'whycode-request-context-'))
  t.after(async () => {
    assert.equal(dirname(root), temporaryDirectory)
    await rm(root, { recursive: true, force: true })
  })
  const store = new SessionStore(join(root, 'sessions'))
  const recorder = await store.create({ workspace: localWorkspace(root), modelId: 'test:context' })
  const events: CoreEvent[] = []
  const model = new MockLanguageModelV4({
    doStream: async () => finalStep(),
    doGenerate: async () => ({
      content: [{ type: 'text', text: '<summary>旧任务已完成。</summary>' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [],
    }),
  })
  const entry: ModelEntry = {
    id: 'test:context', displayName: 'Context', provider: 'openai', protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true, supportsImageInput: true, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000,
    },
    create: () => model,
  }
  const options = {
    model: entry, providerConfig: { apiKey: 'test' }, promptContext: { projectDir: root, osPlatform: 'win32' },
    emit: (event: CoreEvent) => events.push(event), requestApproval: async () => ({ approved: true }),
    ...overrides, sessionRecorder: recorder,
  } satisfies AgentSessionOptions
  const session = new AgentSession(options)
  t.after(() => session.dispose())
  session.restoreMessageSnapshot(history())
  return { root, session, entry, model, options, events }
}

function history(): ModelMessage[] {
  return Array.from({ length: 3 }, (_, index) => [
    { role: 'user' as const, content: `旧任务 ${index}：${'x'.repeat(64_000)}` },
    { role: 'assistant' as const, content: '完成。' },
  ]).flat()
}

function latestUsage(events: CoreEvent[]): ContextUsageInfo {
  const event = events.findLast(event => event.type === 'context-usage')
  assert.ok(event?.type === 'context-usage' && event.usage)
  return event.usage
}

async function mcpFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (init?.method === 'GET') return new Response(null, { status: 405 })
  const request = JSON.parse(String(init?.body)) as {
    id: string | number; method: string; params: { protocolVersion: string }
  }
  if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
  const result = request.method === 'initialize'
    ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1' } }
    : { tools: [{ name: 'probe', description: 'probe', inputSchema: {
      type: 'object', properties: { content: { type: 'string', description: 'x'.repeat(8_000) } },
    } }] }
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
    headers: { 'content-type': 'application/json' },
  })
}

const usage = {
  inputTokens: { total: 60_000, noCache: 60_000, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
}

function finalStep() {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'text-start' as const, id: 'reply' },
    { type: 'text-delta' as const, id: 'reply', delta: '已完成。' },
    { type: 'text-end' as const, id: 'reply' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage },
  ] }) }
}
