import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  createAskUserQuestionTool,
} from '../tools/ask-user-question/index.ts'
import { AgentSession } from './session.ts'

describe('Main 主动提问', () => {
  it('工具说明将问题卡限制为未完成任务的必要等待点', () => {
    const prompt = createAskUserQuestionTool(() => {}).prompt

    assert.match(prompt, /当前用户目标尚未完成/)
    assert.match(prompt, /回答是继续完成该目标的必要条件/)
    assert.match(prompt, /当前任务已经可以完整交付，不得调用本工具/)
    assert.match(prompt, /不得用本工具询问用户是否满意、是否继续或是否需要更多帮助/)
  })

  it('提交问题后结束 turn 并等待用户回答', async () => {
    const model = new MockLanguageModelV4({ doStream: [questionStep(), finalStep()] })
    const events: CoreEvent[] = []
    const session = createSession(model, events)

    const stopReason = await session.handleUserMessage('帮我选一个实现方向')

    assert.equal(stopReason, 'waiting-user')
    assert.equal(model.doStreamCalls.length, 1)
    const questions = events.filter((event) => event.type === 'user-question')
    assert.equal(questions.length, 1)
    assert.equal(
      questions[0]?.type === 'user-question' ? questions[0].question.question : '',
      '你更看重哪一点？',
    )
    assert.equal(
      events.some(
        (event) =>
          event.type === 'tool-end' &&
          event.isError &&
          String(event.result).includes('已经提交了一个问题'),
      ),
      true,
    )
    assert.equal(events.filter((event) => event.type === 'step-committed').length, 1)

    const resumedReason = await session.handleUserMessage('我选择简单可靠')

    assert.equal(resumedReason, 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(
      model.doStreamCalls[1]?.prompt.some(
        (message) => message.role === 'user' && JSON.stringify(message.content).includes('简单可靠'),
      ),
      true,
    )
  })

  it('讨论 Agent 不获得主动提问工具', async () => {
    const model = new MockLanguageModelV4({ doStream: [finalStep()] })
    const session = createSession(model, [])
    session.setDiscussion({ agentId: 'B', scratchDir: 'C:\\whycode-scratch' })

    await session.handleUserMessage('独立评审')

    const names = (model.doStreamCalls[0]?.tools ?? []).map((tool) =>
      tool.type === 'function' ? tool.name : '',
    )
    assert.equal(names.includes(ASK_USER_QUESTION_TOOL_NAME), false)
  })

  it('任务已完成后的普通文本追问不会产生问题卡或等待状态', async () => {
    const model = new MockLanguageModelV4({
      doStream: [finalStep('修改和验证已经完成；如果之后想继续优化缓存，可以再告诉我。')],
    })
    const events: CoreEvent[] = []
    const session = createSession(model, events)

    const stopReason = await session.handleUserMessage('完成当前修改')

    assert.equal(stopReason, 'completed')
    assert.equal(events.some((event) => event.type === 'user-question'), false)
    assert.equal(
      events.some(
        (event) => event.type === 'text-delta' && event.text.includes('之后想继续优化'),
      ),
      true,
    )
  })
})

function createSession(model: MockLanguageModelV4, events: CoreEvent[]): AgentSession {
  return new AgentSession({
    model: modelEntry(model),
    providerConfig: { apiKey: 'test' },
    promptContext: { projectDir: null, osPlatform: 'win32' },
    emit: (event) => events.push(event),
    requestApproval: async () => ({ approved: false }),
  })
}

function questionStep() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'ask-1',
          toolName: ASK_USER_QUESTION_TOOL_NAME,
          input: JSON.stringify({
            header: '实现偏好',
            question: '你更看重哪一点？',
            options: [
              { label: '简单可靠', description: '优先减少复杂度' },
              { label: '功能完整', description: '接受更高实现成本' },
            ],
          }),
        },
        {
          type: 'tool-call' as const,
          toolCallId: 'ask-2',
          toolName: ASK_USER_QUESTION_TOOL_NAME,
          input: JSON.stringify({
            header: '重复问题',
            question: '是否重复提问？',
            options: [
              { label: '不要', description: '只保留第一个问题' },
              { label: '仍然不要', description: '避免多个等待卡片' },
            ],
          }),
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

function finalStep(text = '评审完成') {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'final' },
        { type: 'text-delta' as const, id: 'final', delta: text },
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
    id: 'test:ask-user',
    displayName: 'Ask User Mock',
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

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  }
}
