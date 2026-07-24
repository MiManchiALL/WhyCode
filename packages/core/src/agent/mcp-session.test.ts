import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { McpConfiguration } from '../mcp/config.ts'
import { MCP_TOOL_SEARCH_NAME, McpSessionRuntime } from '../mcp/runtime.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { SessionStore } from '../session/store.ts'
import { AgentSession } from './session.ts'

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
      projectDir: process.cwd(),
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
      promptContext: { projectDir: null, osPlatform: 'win32' },
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
      const reopened = await store.open(recorder.sessionId)
      assert.equal(
        reopened.initialMessages.some((message) =>
          JSON.stringify(message).includes('whycode-mcp-tool-state')),
        true,
      )
    } finally {
      await session.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

function testConfiguration(): McpConfiguration {
  return {
    servers: [{
      name: 'test',
      scope: 'global',
      sourceFingerprint: 'c'.repeat(64),
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
