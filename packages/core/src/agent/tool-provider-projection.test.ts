import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { ModelEntry } from '../providers/registry.ts'
import { buildTool } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('工具 Provider 投影', () => {
  it('仅在 OpenAI Responses 边界显式关闭函数工具 strict 默认值', async () => {
    const probe = buildTool({
      name: 'OptionalInputProbe',
      description: '可选参数探针',
      prompt: '只传已知参数',
      inputSchema: z.object({ required: z.string(), optional: z.string().optional() }),
      isReadOnly: true,
      kind: 'read',
      availableWithoutProject: true,
      async execute() {
        return { data: 'ok', isError: false }
      },
    })

    for (const [protocol, expected] of [
      ['openai-responses', false],
      ['openai-chat', undefined],
      ['anthropic-messages', undefined],
    ] as const) {
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          const advertised = (options.tools ?? []).find((tool) =>
            tool.type === 'function' && tool.name === probe.name)
          assert.ok(advertised?.type === 'function')
          assert.equal(advertised.strict, expected)
          return finalStep()
        },
      })
      const session = new AgentSession({
        model: modelEntry(model, protocol),
        providerConfig: { apiKey: 'test' },
        promptContext: { projectDir: null, osPlatform: 'win32' },
        emit: () => {},
        requestApproval: async () => ({ approved: false }),
      })
      session.setExtraTools([probe])

      assert.equal(await session.handleUserMessage('检查参数协议'), 'completed')
    }
  })

  it('供应商擅自执行未声明工具时不提交孤立结果，后续本地工具继续运行', async () => {
    const probe = buildTool({
      name: 'ProviderBoundaryProbe',
      description: 'Provider 边界探针',
      prompt: '执行本地探针',
      inputSchema: z.object({ value: z.string() }),
      isReadOnly: true,
      kind: 'read',
      availableWithoutProject: true,
      async execute(input) {
        return { data: `local:${input.value}`, isError: false }
      },
    })
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (call++ === 0) return providerExecutedAndLocalStep(probe.name)
        const prompt = JSON.stringify(options.prompt)
        assert.doesNotMatch(prompt, /ig_fixture|image_generation|PROVIDER_IMAGE_BYTES|NoSuchTool/)
        assert.match(prompt, /call-local|local:ok/)
        return finalStep()
      },
    })
    const session = new AgentSession({
      model: modelEntry(model, 'openai-responses'),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      emit: () => {},
      requestApproval: async () => ({ approved: false }),
    })
    session.setExtraTools([probe])
    session.setPermissionMode('auto')

    assert.equal(await session.handleUserMessage('执行边界回归'), 'completed')
    assert.equal(model.doStreamCalls.length, 2)
  })
})

function modelEntry(
  model: MockLanguageModelV4,
  protocol: ModelEntry['protocol'],
): ModelEntry {
  return {
    id: 'test:tool-projection',
    displayName: 'Tool Projection Mock',
    provider: protocol === 'anthropic-messages'
      ? 'anthropic'
      : protocol === 'openai-chat' ? 'google' : 'openai',
    protocol,
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
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
    }),
  }
}

function providerExecutedAndLocalStep(localToolName: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'ig_fixture',
          toolName: 'image_generation',
          input: '{}',
          providerExecuted: true,
        },
        {
          type: 'tool-result' as const,
          toolCallId: 'ig_fixture',
          toolName: 'image_generation',
          result: { result: 'PROVIDER_IMAGE_BYTES' },
        },
        {
          type: 'tool-call' as const,
          toolCallId: 'call-local',
          toolName: localToolName,
          input: '{"value":"ok"}',
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 0, reasoning: 1 },
          },
        },
      ],
    }),
  }
}
