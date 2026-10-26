import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, type TestContext } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import { estimateMessageTokens, estimateTextTokens } from '../context/tokens.ts'
import type { ContextUsageInfo, CoreEvent } from '../events.ts'
import { loadMcpConfiguration, MCP_GLOBAL_CONFIG_TEMPLATE } from '../mcp/config.ts'
import { McpSessionRuntime } from '../mcp/runtime.ts'
import { createMcpToolStateMessage } from '../mcp/state.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { buildTool } from '../tools/tool.ts'
import { localWorkspace } from '../workspace/types.ts'
import { AgentSession, type AgentSessionOptions } from './session.ts'

describe('上下文用量的请求与恢复口径', () => {
  for (const local of [true, false]) {
    it(`${local ? '本地' : 'SSH'}初始化、请求、结束与冷恢复使用相同的工具目录`, async (t) => {
      const { options, events, model, store, session } = await fixture(t, local)
      await session.initializeContextUsage()
      const initial = latestUsage(events)
      assert.equal(await session.handleUserMessage('你好'), 'completed')
      const requestTools = model.doStreamCalls[0]!.tools ?? []
      const names = requestTools.map(tool => tool.name)
      assert.ok(names.includes('ToolSearch'))
      assert.equal(names.includes('CaptureScreenshot'), local)
      assert.equal(initial.breakdown.toolTokens, requestToolTokens(model))
      assert.deepEqual(initial.details.tools, { builtIn: initial.breakdown.toolTokens, mcp: 0 })
      assert.equal(latestUsage(events).breakdown.toolTokens, initial.breakdown.toolTokens)
      assert.equal(latestUsage(events).usedTokens, 50_100, '响应后由 Provider usage 校准总量')

      const restored = new AgentSession({
        ...options,
        sessionRecorder: await store.open(options.sessionRecorder.sessionId),
        mcpRuntime: new McpSessionRuntime({
          configuration: options.mcpRuntime.connectionManager().configuration,
          fetchImpl: async () => { assert.fail('仅查看用量不能连接 MCP') },
        }),
      })
      t.after(() => restored.dispose())
      await restored.initializeContextUsage()
      const reopened = latestUsage(events)
      assert.equal(reopened.breakdown.toolTokens, initial.breakdown.toolTokens)
      assert.equal(reopened.usedTokens, sumBreakdown(reopened), '冷恢复没有 Provider 基线，使用完整估算')
      assert.equal(await restored.handleUserMessage('继续'), 'completed')
      assert.equal(latestUsage(events).breakdown.toolTokens, initial.breakdown.toolTokens)
    })
  }

  for (const mode of ['append', 'replace'] as const) {
    it(`${mode} 模式在初始化和实际请求中使用同一自定义 System 快照计量`, async t => {
      const content = '只使用当前任务提供的规则。'
      const { session, events, model } = await fixture(t, false, { mode, content })
      await session.initializeContextUsage()
      const initial = latestUsage(events)
      const requests: ContextUsageInfo[] = []
      const doStream = model.doStream.bind(model)
      model.doStream = async options => {
        requests.push(latestUsage(events))
        return doStream(options)
      }
      await session.handleUserMessage('你好')
      const system = model.doStreamCalls[0]!.prompt[0]!
      assert.ok(system.role === 'system')
      assert.equal(initial.details.system.mode, mode)
      assert.equal(initial.details.system.custom, estimateTextTokens(content))
      assert.equal(initial.details.system.builtIn === 0, mode === 'replace')
      assert.equal(initial.breakdown.systemPromptTokens, estimateTextTokens(system.content))
      assert.deepEqual(requests[0]!.details.system, initial.details.system)
      assert.deepEqual(latestUsage(events).details.system, initial.details.system)
    })
  }

  it('未配置 MCP 时不虚增 ToolSearch；本机截图独立计入工具开销', async (t) => {
    const { session, model, events, options } = await fixture(t, false)
    await session.initializeContextUsage()
    const remote = latestUsage(events)
    const local = new AgentSession({ ...options, captureScreenshot: async () => { throw new Error('unused') } })
    t.after(() => local.dispose())
    await local.initializeContextUsage()
    const localUsage = latestUsage(events)
    await local.handleUserMessage('你好')
    const screenshot = model.doStreamCalls[0]!.tools?.find(tool => tool.name === 'CaptureScreenshot')
    assert.ok(screenshot?.type === 'function')
    const screenshotTokens = estimateTextTokens(JSON.stringify({
      name: screenshot.name, description: screenshot.description ?? '', inputSchema: screenshot.inputSchema,
    }))
    assert.equal(localUsage.breakdown.toolTokens - remote.breakdown.toolTokens, screenshotTokens)

    const noMcp = new AgentSession({ ...options, mcpRuntime: undefined })
    t.after(() => noMcp.dispose())
    await noMcp.initializeContextUsage()
    assert.ok(latestUsage(events).breakdown.toolTokens < remote.breakdown.toolTokens)
    await noMcp.handleUserMessage('你好')
    assert.equal(model.doStreamCalls.at(-1)!.tools?.some(tool => tool.name === 'ToolSearch'), false)
    assert.equal(latestUsage(events).breakdown.toolTokens, requestToolTokens(model))
  })

  it('MCP 内部恢复标记在冷恢复及后续请求中都不占消息上下文', async (t) => {
    const { session, model, events } = await fixture(t, false)
    const visible = { role: 'user' as const, content: '已有消息' }
    session.restoreMessageSnapshot([visible, createMcpToolStateMessage({
      tools: [],
      serverInstructions: [{
        serverName: 'removed-server', runtimeFingerprint: 'a'.repeat(64), instructions: '内部状态'.repeat(300),
      }],
      trustedProjectConfigurationFingerprint: null,
    })])
    await session.initializeContextUsage()
    const restored = latestUsage(events)
    assert.equal(restored.breakdown.messageTokens, estimateMessageTokens(visible))
    assert.equal(restored.usedTokens, sumBreakdown(restored))
    await session.handleUserMessage('继续')
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[0]!.prompt), /whycode-mcp-tool-state|内部状态/u)
    assert.equal(latestUsage(events).usedTokens, 50_100)
  })

  it('Provider 基线之后增删工具都补计差额，不重复计入固定开销', async (t) => {
    const { session, model, events } = await fixture(t, false)
    await session.handleUserMessage('建立 Provider 基线')
    const initial = latestUsage(events)
    const extra = largeTool()
    session.setExtraTools([extra])
    await session.initializeContextUsage()
    const expanded = latestUsage(events)
    const addedTokens = expanded.breakdown.toolTokens - initial.breakdown.toolTokens
    assert.ok(addedTokens > 1_000)
    assert.equal(expanded.usedTokens, initial.usedTokens + addedTokens)
    const requests: ContextUsageInfo[] = []
    model.doStream = async () => {
      requests.push(latestUsage(events))
      return textStep()
    }
    await session.handleUserMessage('继续')
    assert.equal(requests[0]!.usedTokens, expanded.usedTokens + estimateMessageTokens({ role: 'user', content: '继续' }))
    assert.equal(latestUsage(events).usedTokens, 50_100)
    session.setExtraTools([])
    await session.initializeContextUsage()
    assert.equal(latestUsage(events).usedTokens, 50_100 - addedTokens)
    assert.equal(latestUsage(events).breakdown.toolTokens, initial.breakdown.toolTokens)
  })

  it('自动压缩在请求前检查新增工具开销', async (t) => {
    const { session, events, model } = await fixture(t, false)
    for (let index = 0; index < 3; index++) {
      assert.equal(await session.handleUserMessage('x'.repeat(60_000)), 'completed')
    }
    const initial = latestUsage(events)
    let compactions = 0
    model.doGenerate = async () => {
      compactions++
      return {
        content: [{ type: 'text', text: '<summary>用户要求继续任务。</summary>' }],
        finishReason: { unified: 'stop', raw: undefined }, usage: providerUsage(), warnings: [],
      }
    }
    session.setExtraTools([largeTool(initial.autoCompactThreshold - initial.usedTokens + 1_000)])
    assert.equal(await session.handleUserMessage('继续'), 'completed')
    assert.equal(compactions, 1, '不能等模型返回新 usage 才发现超出压缩阈值')
    assert.ok(events.some(event => event.type === 'context-compacted'))
  })
})

async function fixture(t: TestContext, local: boolean, customSystemPrompt?: AgentSessionOptions['customSystemPrompt']) {
  const temporaryDirectory = await realpath(tmpdir())
  const root = await mkdtemp(join(temporaryDirectory, 'whycode-context-usage-'))
  t.after(async () => {
    assert.equal(dirname(root), temporaryDirectory)
    await rm(root, { recursive: true, force: true })
  })
  const store = new SessionStore(join(root, 'sessions'))
  const sessionRecorder = await store.create({ workspace: localWorkspace(root), modelId: 'test:context-usage' })
  const configurationPath = join(root, 'mcp.json')
  await writeFile(configurationPath, MCP_GLOBAL_CONFIG_TEMPLATE)
  const mcpRuntime = new McpSessionRuntime({
    configuration: await loadMcpConfiguration({ globalConfigPath: configurationPath }),
    fetchImpl: async () => { assert.fail('仅查看用量不能连接 MCP') },
  })
  const events: CoreEvent[] = []
  const model = new MockLanguageModelV4({ doStream: async () => textStep() })
  const entry: ModelEntry = {
    id: 'test:context-usage', displayName: 'Context Usage Mock', provider: 'openai', protocol: 'openai-responses',
    capabilities: {
      supportsNativeTools: true, supportsImageInput: true, reasoningExposure: 'none',
      structuredOutput: 'tool-based', promptCaching: 'none', contextWindow: 100_000, maxOutput: 4_000,
    },
    create: () => model,
  }
  const options = {
    model: entry, providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: root, osPlatform: local ? 'win32' : 'linux' },
    sessionRecorder, mcpRuntime, customSystemPrompt,
    captureScreenshot: local ? async () => { throw new Error('unused') } : undefined,
    emit: (event: CoreEvent) => events.push(event), requestApproval: async () => ({ approved: false }),
  } satisfies AgentSessionOptions
  const session = new AgentSession(options)
  t.after(() => session.dispose())
  return { options, events, model, store, session }
}

function latestUsage(events: CoreEvent[]): ContextUsageInfo {
  const event = events.findLast(event => event.type === 'context-usage')
  assert.ok(event?.type === 'context-usage' && event.usage)
  return event.usage
}

function sumBreakdown(usage: ContextUsageInfo): number {
  return Object.values(usage.breakdown).reduce((sum, tokens) => sum + tokens, 0)
}

function requestToolTokens(model: MockLanguageModelV4): number {
  return (model.doStreamCalls.at(-1)!.tools ?? []).reduce((sum, tool) => {
    assert.ok(tool.type === 'function')
    return sum + estimateTextTokens(JSON.stringify({
      name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
    }))
  }, 0)
}

function largeTool(tokens = 2_000) {
  return buildTool({
    name: 'ContextProbe', description: '用量探针', prompt: 'x'.repeat(tokens * 4),
    inputSchema: z.object({}), isReadOnly: true, kind: 'read',
    execute: async () => ({ data: 'ok', isError: false }),
  })
}

function providerUsage() {
  return {
    inputTokens: { total: 50_000, noCache: 50_000, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 100, text: 100, reasoning: undefined },
  }
}

function textStep() {
  return { stream: simulateReadableStream({ chunks: [
    { type: 'text-start' as const, id: 'reply' },
    { type: 'text-delta' as const, id: 'reply', delta: '你好' },
    { type: 'text-end' as const, id: 'reply' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: providerUsage() },
  ] }) }
}
