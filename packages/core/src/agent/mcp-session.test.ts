import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { McpConfiguration } from '../mcp/config.ts'
import { MCP_TOOL_SEARCH_NAME, McpSessionRuntime } from '../mcp/runtime.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import {
  WEB_SEARCH_TOOL_NAME,
  createWebSearchTool,
} from '../tools/web-search/index.ts'
import { AgentSession } from './session.ts'
import { localWorkspace } from '../workspace/types.ts'

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'mcp',
  'fixtures',
  'echo-server.mjs',
)

describe('AgentSession MCP 生命周期', () => {
  it('检索状态与模型步骤同事务提交，并从所有模型请求中过滤', async () => {
    const root = await mkdtemp(join(tmpdir(), 'whycode-mcp-session-'))
    const store = new SessionStore(root)
    const recorder = await store.create({
      workspace: localWorkspace(process.cwd()),
      modelId: 'test:mcp-session',
    })
    let call = 0
    const visibleToolNames: string[][] = []
    const approvalToolNames: string[] = []
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call++
        const tools = (options.tools ?? []).flatMap((tool) =>
          tool.type === 'function' ? [tool.name] : [])
        visibleToolNames.push(tools)
        if (call === 1) {
          return toolStep(MCP_TOOL_SEARCH_NAME, {
            query: 'echo supplied text',
            max_results: 5,
          })
        }
        if (call === 2) {
          const echo = tools.find((name) => name.startsWith('Mcp__test__echo_text__'))
          assert.ok(echo)
          return toolStep(echo, { text: 'session' })
        }
        return finalStep()
      },
    })
    const runtime = new McpSessionRuntime({ configuration: testConfiguration() })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      mcpRuntime: runtime,
      sessionRecorder: recorder,
      emit: () => {},
      requestApproval: async (request) => {
        approvalToolNames.push(request.toolName)
        return { approved: true }
      },
    })
    try {
      assert.equal(await session.handleUserMessage('用 MCP 回显 session'), 'completed')
      assert.equal(visibleToolNames[0]?.includes(MCP_TOOL_SEARCH_NAME), true)
      assert.equal(
        visibleToolNames[0]?.some((name) => name.startsWith('Mcp__')),
        false,
      )
      assert.equal(
        visibleToolNames[1]?.some((name) => name.startsWith('Mcp__test__echo_text__')),
        true,
      )
      assert.equal(
        approvalToolNames.some((name) => name.startsWith('Mcp__test__echo_text__')),
        true,
      )
      assert.match(
        JSON.stringify(model.doStreamCalls[1]?.prompt),
        /whycode-mcp-tool-search-continuation/,
      )
      assert.equal(
        model.doStreamCalls.some((entry) =>
          JSON.stringify(entry.prompt).includes('whycode-mcp-tool-state')),
        false,
      )
      assert.equal(
        session.captureMessageSnapshot().some((message) =>
          JSON.stringify(message).includes('whycode-mcp-tool-state')),
        true,
      )
      assert.equal(
        session.captureMessageSnapshot().some((message) =>
          JSON.stringify(message).includes('whycode-mcp-tool-search-continuation')),
        true,
      )
      const reopened = await store.open(recorder.sessionId)
      assert.equal(
        reopened.initialMessages.some((message) =>
          JSON.stringify(message).includes('whycode-mcp-tool-state')),
        true,
      )
      assert.equal(
        reopened.initialMessages.some((message) =>
          JSON.stringify(message).includes('whycode-mcp-tool-search-continuation')),
        true,
      )
    } finally {
      await session.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ToolSearch 与 WebSearch 可在同一模型步骤完成，命中工具从下一步出现', async () => {
    let call = 0
    const events: CoreEvent[] = []
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        call++
        const tools = (options.tools ?? []).flatMap((tool) =>
          tool.type === 'function' ? [tool.name] : [])
        if (call === 1) {
          assert.equal(tools.includes(MCP_TOOL_SEARCH_NAME), true)
          assert.equal(tools.includes(WEB_SEARCH_TOOL_NAME), true)
          return parallelToolStep([
            {
              id: 'mcp-search',
              name: MCP_TOOL_SEARCH_NAME,
              input: { query: 'echo supplied text', max_results: 5 },
            },
            {
              id: 'web-search',
              name: WEB_SEARCH_TOOL_NAME,
              input: { query: 'WhyCode public information', max_results: 5 },
            },
          ])
        }
        assert.equal(
          tools.some((name) => name.startsWith('Mcp__test__echo_text__')),
          true,
        )
        const prompt = JSON.stringify(options.prompt)
        assert.match(prompt, /Mcp__test__echo_text__/)
        assert.match(prompt, /https:\/\/example\.com\/whycode/)
        assert.match(prompt, /whycode-mcp-tool-search-continuation/)
        return finalStep()
      },
    })
    const runtime = new McpSessionRuntime({ configuration: testConfiguration() })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      mainTools: [createWebSearchTool({
        search: async () => ({
          results: [{
            title: 'WhyCode',
            url: 'https://example.com/whycode',
            snippet: 'Public WhyCode information',
          }],
        }),
      })],
      mcpRuntime: runtime,
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: true, remember: true }),
    })
    try {
      assert.equal(await session.handleUserMessage('同时查询网页并查找 MCP 工具'), 'completed')
      assert.equal(call, 2)
      for (const id of ['mcp-search', 'web-search']) {
        const result = events.find((event) =>
          event.type === 'tool-end' && event.toolUseId === id)
        assert.ok(result?.type === 'tool-end')
        assert.equal(result.isError, false)
      }
    } finally {
      await session.dispose()
    }
  })
})

function testConfiguration(): McpConfiguration {
  return {
    servers: [{
      name: 'test',
      scope: 'global',
      sourceFingerprint: 'c'.repeat(64),
      runtimeFingerprint: 'd'.repeat(64),
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

function toolStep(toolName: string, input: Record<string, unknown>) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: crypto.randomUUID(),
          toolName,
          input: JSON.stringify(input),
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

function parallelToolStep(
  calls: readonly {
    id: string
    name: string
    input: Record<string, unknown>
  }[],
) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map((call) => ({
          type: 'tool-call' as const,
          toolCallId: call.id,
          toolName: call.name,
          input: JSON.stringify(call.input),
        })),
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
        { type: 'text-delta' as const, id: 'final', delta: '完成' },
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

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:mcp-session',
    displayName: 'MCP Session Mock',
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
