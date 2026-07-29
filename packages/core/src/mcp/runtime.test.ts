import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelMessage } from 'ai'
import { describe, it } from 'node:test'
import { z } from 'zod'
import type { ToolContext } from '../tools/tool.ts'
import {
  MCP_GITHUB_BUILTIN,
  type McpConfiguration,
} from './config.ts'
import type { McpFetch } from './manager.ts'
import { MCP_TOOL_SEARCH_NAME, McpSessionRuntime } from './runtime.ts'
import {
  createMcpToolStateMessage,
  findMcpToolState,
  withoutMcpToolState,
} from './state.ts'

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'echo-server.mjs',
)

describe('MCP 延迟工具检索', () => {
  it('首步只暴露 ToolSearch，检索提交后的下一步才暴露真实具名工具', async () => {
    const runtime = new McpSessionRuntime({
      configuration: testConfiguration(),
    })
    const signal = new AbortController().signal
    const context: ToolContext = {
      projectDir: process.cwd(),
      additionalDirs: [],
      abortSignal: signal,
    }
    try {
      const first = await runtime.beginStep([], signal)
      const firstTools = first.toolDefinitions()
      assert.deepEqual(firstTools.map((tool) => tool.name), [MCP_TOOL_SEARCH_NAME])
      assert.equal(firstTools[0]?.requiresStandaloneStep, false)

      const search = firstTools[0]!
      const searchSchema = z.toJSONSchema(search.inputSchema as z.ZodType)
      const querySchema = searchSchema.properties?.query
      assert.ok(querySchema && typeof querySchema === 'object')
      assert.match(querySchema.description ?? '', /最长 500 字符/)
      assert.match(
        querySchema.description ?? '',
        /GitHub file contents get read/,
      )
      const searchResult = await search.execute(
        { query: 'echo supplied text', max_results: 5 },
        context,
      )
      assert.equal(searchResult.isError, false)
      assert.match(searchResult.data, /Mcp__test__echo_text__/)
      assert.match(searchResult.data, /top-N 候选而不是完整工具目录/)
      assert.match(searchResult.data, /再次调用 ToolSearch/)
      assert.doesNotMatch(searchResult.data, /必须/)

      const messages: ModelMessage[] = first.messagesOnCommit()
      assert.equal(messages.length, 2)
      assert.equal(findMcpToolState(messages).tools.length, 1)
      const modelMessages = withoutMcpToolState(messages)
      assert.equal(modelMessages.length, 1)
      assert.match(String(modelMessages[0]?.content), /^<system-reminder>/u)
      assert.match(
        String(modelMessages[0]?.content),
        /下一模型步骤优先调用上面本次命中的具名 MCP 工具/,
      )
      assert.match(String(modelMessages[0]?.content), /先用更具体/)
      assert.doesNotMatch(String(modelMessages[0]?.content), /必须/)

      const second = await runtime.beginStep(messages, signal)
      const secondTools = second.toolDefinitions()
      assert.equal(secondTools[0]?.name, MCP_TOOL_SEARCH_NAME)
      const echo = secondTools.find((tool) => tool.name.startsWith('Mcp__test__echo_text__'))
      assert.ok(echo)
      const echoResult = await echo.execute({ text: 'hello' }, context)
      assert.equal(echoResult.isError, false)
      assert.match(echoResult.data, /echo:hello/)
      assert.match(echoResult.data, /"echoed": "hello"/)
      assert.deepEqual(second.messagesOnCommit(), [])
    } finally {
      await runtime.close()
    }
  })

  it('零命中时不生成 MCP 后续行动提醒', async () => {
    const runtime = new McpSessionRuntime({
      configuration: testConfiguration(),
    })
    const signal = new AbortController().signal
    try {
      const step = await runtime.beginStep([], signal)
      const result = await step.toolDefinitions()[0]!.execute(
        { query: 'unrelated-token-with-no-overlap', max_results: 5 },
        {
          projectDir: process.cwd(),
          additionalDirs: [],
          abortSignal: signal,
        },
      )
      assert.match(result.data, /本次查询没有找到匹配/)
      assert.match(result.data, /不表示已配置服务一定不支持/)
      assert.match(result.data, /再次调用 ToolSearch/)
      assert.deepEqual(step.messagesOnCommit(), [])
    } finally {
      await runtime.close()
    }
  })

  it('项目服务器首次显式信任后按会话恢复；路由身份变化时重新审批', async () => {
    const configuration = testConfiguration()
    configuration.servers[0] = {
      ...configuration.servers[0]!,
      scope: 'project',
    }
    configuration.projectConfigDigest = 'a'.repeat(64)
    configuration.projectServerCount = 1
    const runtime = new McpSessionRuntime({ configuration })
    const signal = new AbortController().signal
    const context: ToolContext = {
      projectDir: process.cwd(),
      additionalDirs: [],
      abortSignal: signal,
    }
    try {
      const step = await runtime.beginStep([], signal)
      const search = step.toolDefinitions()[0]!
      assert.equal(search.requiresExplicitInitialApproval, true)
      assert.match(search.initialApprovalReason ?? '', /显式信任/)
      await search.execute({ query: 'echo text', max_results: 5 }, context)
      const committed = step.messagesOnCommit()
      const state = findMcpToolState(committed)
      assert.match(
        state.trustedProjectConfigurationFingerprint ?? '',
        /^[0-9a-f]{64}$/u,
      )

      const resumed = new McpSessionRuntime({ configuration })
      try {
        const resumedStep = await resumed.beginStep(committed, signal)
        const resumedSearch = resumedStep.toolDefinitions()[0]!
        assert.equal(resumedSearch.requiresExplicitInitialApproval, false)
        assert.equal(resumedSearch.initialApprovalReason, undefined)
        assert.equal(
          resumedStep.toolDefinitions().some((tool) =>
            tool.name.includes('__echo_text__')),
          true,
        )
        resumedStep.discard()
      } finally {
        await resumed.close()
      }

      const changed = structuredClone(configuration)
      changed.servers[0]!.runtimeFingerprint = 'f'.repeat(64)
      const changedRuntime = new McpSessionRuntime({ configuration: changed })
      try {
        const changedStep = await changedRuntime.beginStep(committed, signal)
        const changedSearch = changedStep.toolDefinitions()[0]!
        assert.equal(changedSearch.requiresExplicitInitialApproval, true)
        assert.equal(
          changedStep.toolDefinitions().some((tool) =>
            tool.name.includes('__echo_text__')),
          false,
        )
        const cleared = findMcpToolState(changedStep.messagesOnCommit())
        assert.equal(cleared.trustedProjectConfigurationFingerprint, null)
        assert.deepEqual(cleared.tools, [])
      } finally {
        await changedRuntime.close()
      }
    } finally {
      await runtime.close()
    }
  })

  it('连接前说明内置来源能力，并在公开读取失败或明确授权需求后路由到 ToolSearch', async () => {
    const runtime = new McpSessionRuntime({
      configuration: githubConfiguration(),
    })
    try {
      const step = await runtime.beginStep([], new AbortController().signal)
      const search = step.toolDefinitions()[0]!
      assert.match(search.prompt, /读取 GitHub 仓库、文件、提交、Issue 和 Pull Request/)
      assert.match(search.prompt, /私有资源/)
      assert.match(search.prompt, /登录身份、授权能力或私有数据/)
      assert.match(search.prompt, /WebSearch\/WebFetch 已不能取得所需公开内容/)
      assert.match(search.prompt, /普通 HTTP\/HTTPS URL.*先用 WebFetch 尝试公开读取/)
      assert.match(search.prompt, /top-N 候选，不是完整目录/)
      assert.match(search.prompt, /英文动作、对象或参数关键词/)
      assert.match(search.prompt, /可以和本步骤的 WebSearch、WebFetch/)
      step.discard()
    } finally {
      await runtime.close()
    }
  })

  it('首次检索持久化所有已连接服务器说明，但只加载命中的工具', async () => {
    const listCalls = new Map<string, number>()
    const fetchImpl: McpFetch = async (input, init) => {
      const serverName = new URL(String(input)).hostname.split('.')[0]!
      if (init?.method === 'GET') return new Response(null, { status: 405 })
      const request = JSON.parse(String(init?.body)) as {
        id?: string | number
        method: string
        params?: { protocolVersion?: string }
      }
      if (request.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (request.method === 'initialize') {
        return jsonRpcResponse(request.id, {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: serverName, version: '1.0.0' },
          instructions: `${serverName}-server-instructions`,
        })
      }
      if (request.method === 'tools/list') {
        listCalls.set(serverName, (listCalls.get(serverName) ?? 0) + 1)
        return jsonRpcResponse(request.id, {
          tools: [{
            name: serverName === 'alpha' ? 'get_file_contents' : 'schedule_event',
            description: serverName === 'alpha'
              ? 'Read repository source file contents'
              : 'Schedule a calendar appointment',
            inputSchema: { type: 'object', properties: {} },
          }],
        })
      }
      throw new Error(`未处理的 MCP HTTP 方法：${request.method}`)
    }
    const runtime = new McpSessionRuntime({
      configuration: {
        servers: ['alpha', 'beta'].map((name, index) => ({
          name,
          scope: 'global' as const,
          sourceFingerprint: String(index + 1).repeat(64),
          runtimeFingerprint: String(index + 3).repeat(64),
          connectionFingerprint: String(index + 5).repeat(64),
          transport: 'http' as const,
          url: `https://${name}.example.test/`,
          headers: {},
          startupTimeoutMs: 10_000,
          toolTimeoutMs: 10_000,
        })),
        configuredServers: [],
        diagnostics: [],
        projectConfigDigest: null,
        projectServerCount: 0,
      },
      fetchImpl,
    })
    const signal = new AbortController().signal
    const context: ToolContext = {
      projectDir: process.cwd(),
      additionalDirs: [],
      abortSignal: signal,
    }
    try {
      const first = await runtime.beginStep([], signal)
      await first.toolDefinitions()[0]!.execute(
        { query: 'repository file contents read', max_results: 1 },
        context,
      )
      const committed = first.messagesOnCommit()
      const state = findMcpToolState(committed)
      assert.deepEqual(
        state.serverInstructions.map((snapshot) => snapshot.serverName),
        ['alpha', 'beta'],
      )
      assert.equal(state.tools.length, 1)
      assert.equal(state.tools[0]?.serverName, 'alpha')

      const second = await runtime.beginStep(committed, signal)
      const definitions = second.toolDefinitions()
      assert.equal(
        definitions.some((definition) => definition.name.includes('__get_file_contents__')),
        true,
      )
      assert.equal(
        definitions.some((definition) => definition.name.includes('__schedule_event__')),
        false,
      )
      assert.match(definitions[0]?.prompt ?? '', /alpha-server-instructions/)
      assert.match(definitions[0]?.prompt ?? '', /beta-server-instructions/)
      assert.doesNotMatch(definitions[0]?.prompt ?? '', /idle|ready|全局|项目级/u)
      await definitions[0]!.execute(
        { query: 'repository file contents read', max_results: 1 },
        context,
      )
      const repeatedMessages = [...committed, ...second.messagesOnCommit()]
      assert.deepEqual(Object.fromEntries(listCalls), { alpha: 1, beta: 1 })

      listCalls.clear()
      const resumedRuntime = new McpSessionRuntime({
        configuration: runtime.connectionManager().configuration,
        fetchImpl,
      })
      try {
        const resumed = await resumedRuntime.beginStep(repeatedMessages, signal)
        const resumedPrompt = resumed.toolDefinitions()[0]?.prompt
        assert.match(resumedPrompt ?? '', /alpha-server-instructions/)
        assert.match(resumedPrompt ?? '', /beta-server-instructions/)
        assert.deepEqual(Object.fromEntries(listCalls), { alpha: 1 })
        resumed.discard()

        const unchanged = await resumedRuntime.beginStep(repeatedMessages, signal)
        assert.equal(unchanged.toolDefinitions()[0]?.prompt, resumedPrompt)
        unchanged.discard()
      } finally {
        await resumedRuntime.close()
      }
    } finally {
      await runtime.close()
    }
  })

  it('恢复会话时清理已移除服务器的工具与初始化说明', async () => {
    const previousState = createMcpToolStateMessage({
      tools: [{
        id: 'a'.repeat(64),
        descriptorHash: 'b'.repeat(64),
        serverName: 'removed',
      }],
      serverInstructions: [{
        serverName: 'removed',
        runtimeFingerprint: 'c'.repeat(64),
        instructions: 'removed-server-instructions',
      }],
      trustedProjectConfigurationFingerprint: null,
    })
    const runtime = new McpSessionRuntime({
      configuration: {
        servers: [],
        configuredServers: [],
        diagnostics: [],
        projectConfigDigest: null,
        projectServerCount: 0,
      },
    })
    try {
      const step = await runtime.beginStep(
        [previousState],
        new AbortController().signal,
      )
      assert.deepEqual(step.toolDefinitions(), [])
      const committed = step.messagesOnCommit()
      assert.equal(committed.length, 1)
      assert.deepEqual(findMcpToolState(committed), {
        tools: [],
        serverInstructions: [],
        trustedProjectConfigurationFingerprint: null,
      })
    } finally {
      await runtime.close()
    }
  })

  it('目录变更通知立即使当前步骤的旧绑定失效', async () => {
    const runtime = new McpSessionRuntime({ configuration: testConfiguration() })
    const signal = new AbortController().signal
    const context: ToolContext = {
      projectDir: process.cwd(),
      additionalDirs: [],
      abortSignal: signal,
    }
    try {
      const searchStep = await runtime.beginStep([], signal)
      const search = searchStep.toolDefinitions()[0]!
      await search.execute(
        { query: 'echo text and change catalog', max_results: 8 },
        context,
      )
      const committed = searchStep.messagesOnCommit()
      assert.equal(findMcpToolState(committed).tools.length > 0, true)

      const callStep = await runtime.beginStep(committed, signal)
      const tools = callStep.toolDefinitions()
      const echo = tools.find((tool) => tool.name.includes('__echo_text__'))
      const change = tools.find((tool) => tool.name.includes('__change_catalog__'))
      assert.ok(echo)
      assert.ok(change)
      await change.execute({}, context)
      await waitUntil(() =>
        runtime.connectionManager().snapshot(true).tools.some((tool) =>
          tool.rawName === 'late_tool'))
      await assert.rejects(
        echo.execute({ text: 'stale' }, context),
        /目录在本步骤开始后发生变化/,
      )
      callStep.discard()
    } finally {
      await runtime.close()
    }
  })

  it('Streamable HTTP 使用注入传输完成握手、目录与工具调用', async () => {
    const methods: string[] = []
    const fetchImpl: McpFetch = async (input, init) => {
      assert.equal(String(input), 'https://mcp.example.test/')
      if (init?.method === 'GET') return new Response(null, { status: 405 })
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-secret')
      assert.equal(init?.credentials, 'omit')
      assert.equal(init?.redirect, 'error')
      const request = JSON.parse(String(init?.body)) as {
        id?: string | number
        method: string
        params?: { protocolVersion?: string; name?: string; arguments?: unknown }
      }
      methods.push(request.method)
      if (request.method === 'notifications/initialized') {
        return new Response(null, { status: 202 })
      }
      if (request.method === 'initialize') {
        return jsonRpcResponse(request.id, {
          protocolVersion: request.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'http-test', version: '1.0.0' },
          instructions: [
            'Use this server for authenticated repository data.',
            'x'.repeat(2_500),
            'UNBOUNDED_SUFFIX',
          ].join('\n'),
        })
      }
      if (request.method === 'tools/list') {
        return jsonRpcResponse(request.id, {
          tools: [{
            name: 'http_echo',
            description: 'Echoes text over Streamable HTTP',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          }],
        })
      }
      if (request.method === 'tools/call') {
        return jsonRpcResponse(request.id, {
          content: [{
            type: 'text',
            text: `http:${String((request.params?.arguments as { text?: unknown })?.text)}`,
          }],
        })
      }
      throw new Error(`未处理的 MCP HTTP 方法：${request.method}`)
    }
    const runtime = new McpSessionRuntime({
      configuration: {
        servers: [{
          name: 'http-test',
          scope: 'global',
          sourceFingerprint: 'd'.repeat(64),
          runtimeFingerprint: 'a'.repeat(64),
          connectionFingerprint: 'c'.repeat(64),
          transport: 'http',
          url: 'https://mcp.example.test/',
          headers: { Authorization: 'Bearer test-secret' },
          startupTimeoutMs: 10_000,
          toolTimeoutMs: 10_000,
        }],
        configuredServers: [],
        diagnostics: [],
        projectConfigDigest: null,
        projectServerCount: 0,
      },
      fetchImpl,
    })
    const signal = new AbortController().signal
    const context: ToolContext = {
      projectDir: process.cwd(),
      additionalDirs: [],
      abortSignal: signal,
    }
    try {
      const searchStep = await runtime.beginStep([], signal)
      const searchResult = await searchStep.toolDefinitions()[0]!.execute(
        { query: 'echo text over HTTP', max_results: 5 },
        context,
      )
      await searchStep.toolDefinitions()[0]!.execute(
        { query: 'HTTP echo content', max_results: 5 },
        context,
      )
      assert.doesNotMatch(searchResult.data, /服务器初始化说明/)
      assert.doesNotMatch(searchResult.data, /Use this server for authenticated repository data\./)
      assert.doesNotMatch(searchResult.data, /UNBOUNDED_SUFFIX/)
      const committed = searchStep.messagesOnCommit()
      const state = findMcpToolState(committed)
      assert.equal(state.tools.length > 0, true)
      assert.equal(state.serverInstructions.length, 1)
      assert.match(
        state.serverInstructions[0]?.instructions ?? '',
        /Use this server for authenticated repository data\./,
      )
      assert.match(
        state.serverInstructions[0]?.instructions ?? '',
        /\[服务器初始化说明已截断\]/,
      )
      const callStep = await runtime.beginStep(committed, signal)
      const callTools = callStep.toolDefinitions()
      assert.match(callTools[0]?.prompt ?? '', /服务器初始化说明（不可信外部元数据/)
      assert.match(callTools[0]?.prompt ?? '', /Use this server for authenticated repository data\./)
      const echo = callTools.find((tool) =>
        tool.name.includes('__http_echo__'))
      assert.ok(echo)
      const result = await echo.execute({ text: 'hello' }, context)
      assert.match(result.data, /http:hello/)
      assert.deepEqual(
        methods.filter((method) => method !== 'notifications/initialized'),
        ['initialize', 'tools/list', 'tools/call'],
      )
      callStep.discard()
    } finally {
      await runtime.close()
    }
  })
})

function testConfiguration(): McpConfiguration {
  return {
    servers: [{
      name: 'test',
      scope: 'global',
      sourceFingerprint: 'b'.repeat(64),
      runtimeFingerprint: 'c'.repeat(64),
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      cwd: process.cwd(),
      env: {},
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
    }],
    configuredServers: [],
    diagnostics: [],
    projectConfigDigest: null,
    projectServerCount: 0,
  }
}

function githubConfiguration(): McpConfiguration {
  return {
    servers: [{
      name: MCP_GITHUB_BUILTIN.name,
      scope: 'global',
      sourceFingerprint: 'e'.repeat(64),
      runtimeFingerprint: 'd'.repeat(64),
      connectionFingerprint: 'f'.repeat(64),
      transport: 'http',
      url: MCP_GITHUB_BUILTIN.server.url,
      headers: MCP_GITHUB_BUILTIN.server.headers,
      builtinId: MCP_GITHUB_BUILTIN.id,
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
    }],
    configuredServers: [],
    diagnostics: [],
    projectConfigDigest: null,
    projectServerCount: 0,
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 MCP 目录刷新超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function jsonRpcResponse(id: string | number | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
