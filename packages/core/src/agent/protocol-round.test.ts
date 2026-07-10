import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { runProtocolRound } from '../consensus/run-round.ts'
import { AgentSession } from './session.ts'

describe('协议回合终止语义', () => {
  it('成功提交协议后不再发起下一次模型调用', async () => {
    const model = mockModel([validSubmission('main_only')])
    const { session, events } = createSession(model)
    const result = await runProtocolRound(session, '讨论今天吃什么', m1Spec)

    assert.equal(result.ok, true)
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(events.some((event) => event.type === 'text-delta'), false)
    assert.equal(
      events.some((event) => event.type === 'thinking-delta' && event.text === '正在形成实质判断'),
      true,
    )
    assert.equal(events.some((event) => event.type === 'thinking-end'), true)
    assert.equal(events.filter((event) => event.type === 'step-committed').length, 1)
    assert.equal(events.some((event) => event.type === 'step-discarded'), false)
    assert.equal(
      events.some(
        (event) => event.type === 'tool-start' && event.toolName === 'SubmitProtocolOutput',
      ),
      true,
    )
    assert.equal(
      events.some((event) => event.type === 'tool-end' && !event.isError),
      true,
    )
    const tools = model.doStreamCalls[0]!.tools ?? []
    assert.equal(tools.length, 1)
    assert.equal(tools[0]!.type, 'function')
    if (tools[0]!.type === 'function') assert.equal(tools[0]!.name, 'SubmitProtocolOutput')
  })

  it('协议校验失败时继续调用模型修正', async () => {
    const model = mockModel([
      invalidVoteSubmission(),
      validVoteSubmission(),
    ])
    const result = await runProtocolRound(createSession(model).session, '评价 M1', quickSpec)

    assert.equal(result.ok, true)
    assert.equal(model.doStreamCalls.length, 2)
  })

  it('控制面锁定 full_consensus 后拒绝模型降级', async () => {
    const model = mockModel([
      validSubmission('main_only'),
      validSubmission('full_consensus'),
    ])
    const result = await runProtocolRound(
      createSession(model).session,
      '进行三agent协商',
      { ...m1Spec, forcedProtocolMode: 'full_consensus' },
    )

    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.output.protocolMode, 'full_consensus')
    assert.equal(model.doStreamCalls.length, 2)
  })
})

const m1Spec = {
  agentId: 'Main' as const,
  round: 1 as const,
  kind: 'full' as const,
  mustVote: [],
  existingCandidateIds: [],
  requireProtocolMode: true,
}

const quickSpec = {
  agentId: 'B' as const,
  round: 1 as const,
  kind: 'quick' as const,
  mustVote: ['M1'],
  existingCandidateIds: ['M1'],
  requireProtocolMode: false,
}

function createSession(model: MockLanguageModelV4): {
  session: AgentSession
  events: CoreEvent[]
} {
  const events: CoreEvent[] = []
  const session = new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: null, osPlatform: 'win32' },
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
  })
  session.setDiscussion({ agentId: 'Main', scratchDir: 'C:\\whycode-test-scratch' })
  return { session, events }
}

function modelEntry(model: MockLanguageModelV4): ModelEntry {
  return {
    id: 'test:mock',
    displayName: 'Mock',
    provider: 'openai',
    capabilities: {
      supportsNativeTools: true,
      reasoningExposure: 'none',
      structuredOutput: 'tool-based',
      promptCaching: 'none',
      contextWindow: 100_000,
      maxOutput: 4_000,
    },
    create: () => model,
  }
}

function mockModel(toolInputs: Record<string, unknown>[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: toolInputs.map((input, index) => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'reasoning-start' as const, id: `reasoning-${index}` },
          {
            type: 'reasoning-delta' as const,
            id: `reasoning-${index}`,
            delta: '正在形成实质判断',
          },
          { type: 'reasoning-end' as const, id: `reasoning-${index}` },
          { type: 'text-start' as const, id: `text-${index}` },
          { type: 'text-delta' as const, id: `text-${index}`, delta: '协议阶段候选说明' },
          { type: 'text-end' as const, id: `text-${index}` },
          {
            type: 'tool-call' as const,
            toolCallId: `call-${index}`,
            toolName: 'SubmitProtocolOutput',
            input: JSON.stringify(input),
          },
          {
            type: 'finish' as const,
            finishReason: { unified: 'tool-calls' as const, raw: undefined },
            usage: usage(),
          },
        ],
      }),
    })),
  })
}

function validSubmission(protocolMode: 'main_only' | 'quick_review' | 'full_consensus') {
  return {
    protocol_mode: protocolMode,
    candidate: {
      summary: '候选摘要',
      final_answer_or_plan: '完整方案',
    },
  }
}

function invalidVoteSubmission() {
  return { vote: 'reject', reason: '不同意' }
}

function validVoteSubmission() {
  return { vote: 'reject', reason: '不同意', suggested_change: '调整方案' }
}

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
