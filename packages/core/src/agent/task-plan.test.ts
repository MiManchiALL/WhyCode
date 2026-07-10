import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { activeTaskPlanSchema, type ActiveTaskPlan } from '../tasks/types.ts'
import {
  CLOSE_TASK_PLAN_TOOL_NAME,
  CREATE_TASK_PLAN_TOOL_NAME,
  UPDATE_TASK_ITEM_TOOL_NAME,
} from '../tasks/tools.ts'
import { AgentSession } from './session.ts'

describe('Main 长任务端到端控制', () => {
  it('任务工具在纯聊天 Main 中可用，计划状态随每步注入并由证据关闭', async () => {
    const model = modelWithSteps([
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '交付可靠功能',
        items: [
          { kind: 'work', title: '实现功能', acceptance: '代码完成' },
          { kind: 'verification', title: '验证功能', acceptance: '测试通过' },
        ],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'completed',
        evidence: ['实现文件已检查'],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T2',
        status: 'completed',
        evidence: ['自动化测试通过'],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'completed',
        summary: '实现与验证均完成',
      }),
      finalStep('全部完成'),
    ])
    const { session, events } = createSession(model)

    const result = await session.handleUserMessage('完成复杂任务')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 5)
    assert.match(JSON.stringify(model.doStreamCalls[1]), /交付可靠功能|T1/)
    const updates = events.filter((event) => event.type === 'task-plan-updated')
    assert.equal(updates.length, 4)
    assert.equal(updates.at(-1)?.type === 'task-plan-updated' && updates.at(-1)?.plan.status, 'completed')
  })

  it('计划未完成时阻止提前宣称结束，两次提醒后保留计划并暂停', async () => {
    const model = modelWithSteps([
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '不能半途结束',
        items: [
          { kind: 'work', title: '实现', acceptance: '实现完成' },
          { kind: 'verification', title: '验证', acceptance: '测试通过' },
        ],
      }),
      finalStep('已经完成'),
      finalStep('真的完成'),
      finalStep('仍然直接结束'),
    ])
    const { session, events } = createSession(model)

    const result = await session.handleUserMessage('执行但不要漏项')

    assert.equal(result, 'paused')
    assert.equal(model.doStreamCalls.length, 4)
    assert.match(JSON.stringify(model.doStreamCalls[2]), /仍有未完成项/)
    assert.equal(
      events.some(
        (event) => event.type === 'error' && event.message.includes('尝试提前结束'),
      ),
      true,
    )
    assert.equal(session.captureTaskPlanSnapshot()?.goal, '不能半途结束')
  })

  it('恢复的未结束计划不覆盖新用户问题，也不阻止普通回答结束', async () => {
    const model = modelWithSteps([finalStep('你刚刚要求不要安装依赖。')])
    const { session } = createSession(model)
    session.restoreTaskPlanSnapshot(activePlan())

    const result = await session.handleUserMessage('我刚刚说了什么')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(session.captureTaskPlanSnapshot()?.goal, '完成旧的复杂任务')
    const request = JSON.stringify(model.doStreamCalls[0])
    assert.match(request, /当前未结束任务计划（背景状态）/)
    assert.ok(
      request.indexOf('当前未结束任务计划（背景状态）') < request.indexOf('我刚刚说了什么'),
      '计划背景必须位于最新真实用户消息之前',
    )
  })

  it('恢复计划在本轮重新更新后重新启用未完成保护', async () => {
    const model = modelWithSteps([
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'in_progress',
      }),
      finalStep('过早结束一'),
      finalStep('过早结束二'),
      finalStep('过早结束三'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskPlanSnapshot(activePlan())

    const result = await session.handleUserMessage('继续刚才的任务')

    assert.equal(result, 'paused')
    assert.equal(model.doStreamCalls.length, 4)
    assert.equal(
      events.some(
        (event) => event.type === 'error' && event.message.includes('尝试提前结束'),
      ),
      true,
    )
  })
})

function activePlan(): ActiveTaskPlan {
  return activeTaskPlanSchema.parse({
    id: '00000000-0000-4000-8000-000000000001',
    goal: '完成旧的复杂任务',
    status: 'active',
    revision: 3,
    items: [
      {
        id: 'T1',
        kind: 'work',
        title: '实现剩余功能',
        acceptance: '代码完成',
        status: 'in_progress',
        evidence: [],
      },
      {
        id: 'T2',
        kind: 'verification',
        title: '验证结果',
        acceptance: '测试通过',
        status: 'pending',
        evidence: [],
      },
    ],
  })
}

function createSession(model: MockLanguageModelV4) {
  const events: CoreEvent[] = []
  return {
    session: new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir: null, osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    }),
    events,
  }
}

type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>

function modelWithSteps(steps: NonNullable<MockOptions['doStream']>): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: steps })
}

function toolStep(toolName: string, input: unknown) {
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

function finalStep(text: string) {
  const id = crypto.randomUUID()
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id },
        { type: 'text-delta' as const, id, delta: text },
        { type: 'text-end' as const, id },
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
    id: 'test:task-plan',
    displayName: 'Task Plan Mock',
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
