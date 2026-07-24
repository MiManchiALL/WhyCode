import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ModelMessage } from 'ai'
import { describe, it } from 'node:test'
import type { ToolContext } from '../tools/tool.ts'
import type { McpConfiguration } from './config.ts'
import type { McpFetch } from './manager.ts'
import { MCP_TOOL_SEARCH_NAME, McpSessionRuntime } from './runtime.ts'
import { findMcpToolState, withoutMcpToolState } from './state.ts'

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
      assert.equal(firstTools[0]?.requiresStandaloneStep, true)

      const search = firstTools[0]!
      const searchResult = await search.execute(
        { query: 'echo supplied text', max_results: 5 },
        context,
      )
      assert.equal(searchResult.isError, false)
      assert.match(searchResult.data, /Mcp__test__echo_text__/)

      const state = first.stateMessageOnCommit()
      assert.ok(state)
      const messages: ModelMessage[] = [state]
      assert.equal(findMcpToolState(messages).length, 1)
      assert.deepEqual(withoutMcpToolState(messages), [])

      const second = await runtime.beginStep(messages, signal)
      const secondTools = second.toolDefinitions()
      assert.equal(secondTools[0]?.name, MCP_TOOL_SEARCH_NAME)
      const echo = secondTools.find((tool) => tool.name.startsWith('Mcp__test__echo_text__'))
      assert.ok(echo)
      const echoResult = await echo.execute({ text: 'hello' }, context)
      assert.equal(echoResult.isError, false)
      assert.match(echoResult.data, /echo:hello/)
      assert.match(echoResult.data, /"echoed": "hello"/)
      assert.equal(second.stateMessageOnCommit(), null)
    } finally {
      await runtime.close()
    }
  })

  it('项目服务器让 ToolSearch 在全自动模式下也声明显式首次信任', async () => {
    const configuration = testConfiguration()
    configuration.servers[0] = {
      ...configuration.servers[0]!,
      scope: 'project',
    }
    configuration.projectConfigDigest = 'a'.repeat(64)
    configuration.projectServerCount = 1
    const runtime = new McpSessionRuntime({ configuration })
    try {
      const step = await runtime.beginStep([], new AbortController().signal)
      const search = step.toolDefinitions()[0]!
      assert.equal(search.requiresExplicitInitialApproval, true)
      assert.match(search.initialApprovalReason ?? '', /显式信任/)
      step.discard()
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
      const state = searchStep.stateMessageOnCommit()
      assert.ok(state)

      const callStep = await runtime.beginStep([state], signal)
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
          transport: 'http',
          url: 'https://mcp.example.test/',
          headers: { Authorization: 'Bearer test-secret' },
          startupTimeoutMs: 10_000,
          toolTimeoutMs: 10_000,
        }],
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
      await searchStep.toolDefinitions()[0]!.execute(
        { query: 'echo text over HTTP', max_results: 5 },
        context,
      )
      const state = searchStep.stateMessageOnCommit()
      assert.ok(state)
      const callStep = await runtime.beginStep([state], signal)
      const echo = callStep.toolDefinitions().find((tool) =>
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
      transport: 'stdio',
      command: process.execPath,
      args: [fixture],
      cwd: process.cwd(),
      env: {},
      startupTimeoutMs: 10_000,
      toolTimeoutMs: 10_000,
    }],
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
