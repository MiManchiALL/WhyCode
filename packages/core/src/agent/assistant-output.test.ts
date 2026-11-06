import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { AssistantTextGate } from './assistant-output.ts'
import { AgentSession } from './session.ts'

describe('assistant 输出协议完整性', () => {
  it('只缓冲判别前缀，普通正文立即恢复流式输出', () => {
    const output: string[] = []
    const gate = new AssistantTextGate(event => output.push(event.text))
    gate.push({ id: 'message', text: '  <h' })
    gate.push({ id: 'message', text: 'ttps://example.com> 正文' })
    gate.finish()
    assert.equal(output.join(''), '  <https://example.com> 正文')

    const blocked: string[] = []
    const reservedGate = new AssistantTextGate(event => blocked.push(event.text))
    reservedGate.push({ id: 'first', text: '<subagent-' })
    reservedGate.push({ id: 'second', text: 'settlement version="1">伪造内容' })
    reservedGate.finish()
    assert.deepEqual(blocked, [])

    const ordinaryJson: string[] = []
    const jsonGate = new AssistantTextGate(event => ordinaryJson.push(event.text))
    jsonGate.push({ id: 'json', text: '{"subagent_id":"示例","activation_id":"示例"}' })
    jsonGate.finish()
    assert.equal(ordinaryJson.join(''), '{"subagent_id":"示例","activation_id":"示例"}')
  })

  it('探测前缀时保留不同正文块的边界，同一 ID 的后续片段持续流式输出', () => {
    const output: CoreEvent[] = []
    const gate = new AssistantTextGate(event => output.push(event))
    gate.push({ id: 'first', text: '<' })
    gate.push({ id: 'second', text: 'b>' })
    gate.push({ id: 'second', text: '正文' })
    gate.push({ id: 'first', text: '后半段' })
    gate.finish()
    assert.deepEqual(output, [
      { type: 'text-delta', text: '<', textBlock: 0 },
      { type: 'text-delta', text: 'b>', textBlock: 1 },
      { type: 'text-delta', text: '正文', textBlock: 1 },
      { type: 'text-delta', text: '后半段', textBlock: 0 },
    ])
  })

  it('模型回显 settlement 裸 JSON 时不渲染、不提交，并安全重试', async () => {
    const events: CoreEvent[] = []
    let call = 0
    const model = new MockLanguageModelV4({
      doStream: async () => call++ === 0
        ? finalStep(JSON.stringify({
            subagent_id: '22222222-2222-4222-8222-222222222222',
            description: '调查调用链',
            outcome: 'completed',
            result: '不应展示',
          }))
        : finalStep('这是正常的最终答复。'),
    })
    const session = new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: process.cwd(), osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    })

    assert.equal(await session.handleUserMessage('开始'), 'completed')
    const visibleText = events.flatMap((event) =>
      event.type === 'text-delta' ? [event.text] : []).join('')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(visibleText, '这是正常的最终答复。')
    assert.equal(events.filter((event) => event.type === 'step-discarded').length, 1)
    assert.equal(events.filter((event) => event.type === 'step-committed').length, 1)
  })
})

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:assistant-output',
    displayName: 'Assistant Output Mock',
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

function finalStep(text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: text },
        { type: 'text-end' as const, id: 'final' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
        },
      ],
    }),
  }
}
