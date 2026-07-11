import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import { findPendingUserQuestion } from '../tasks/answer-resume.ts'
import { activeTaskPlanSchema, type ActiveTaskPlan } from '../tasks/types.ts'
import {
  ADD_TASK_ITEM_TOOL_NAME,
  CLOSE_TASK_PLAN_TOOL_NAME,
  CREATE_TASK_PLAN_TOOL_NAME,
  REPLACE_TASK_PLAN_TOOL_NAME,
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
    assert.match(request, /未结束任务的只读参考/)
    assert.match(request, /旧任务主题：完成旧的复杂任务/)
    assert.doesNotMatch(request, /实现剩余功能|验证结果|代码完成|测试通过/)
    assert.ok(
      request.indexOf('未结束任务的只读参考') < request.indexOf('我刚刚说了什么'),
      '计划背景必须位于最新真实用户消息之前',
    )
    for (const name of taskPlanToolNames()) {
      assert.equal(toolNames(model.doStreamCalls[0]).includes(name), false)
    }
  })

  it('咨询旧任务方案时保持计划休眠，不允许模型误写进度', async () => {
    const model = modelWithSteps([finalStep('可以先比较两种方案，再由你决定。')])
    const { session } = createSession(model)
    session.restoreTaskPlanSnapshot(activePlan())

    const result = await session.handleUserMessage('不用外部依赖是不是会好一点，你觉得呢')

    assert.equal(result, 'completed')
    assert.deepEqual(session.captureTaskPlanSnapshot(), activePlan())
    for (const name of taskPlanToolNames()) {
      assert.equal(toolNames(model.doStreamCalls[0]).includes(name), false)
    }
  })

  it('休眠计划按最新消息收窄本地工具，明确新操作也不会误改旧计划', async () => {
    const model = modelWithSteps([
      finalStep('《蔚蓝》仍有稳定玩家群体。'),
      finalStep('这是一个游戏项目。'),
      finalStep('可以新建文件。'),
    ])
    const { session } = createSession(model, 'E:\\Test')
    session.restoreTaskPlanSnapshot(activePlan())

    assert.equal(await session.handleUserMessage('这个游戏目前玩的人多吗'), 'completed')
    const knowledgeTools = toolNames(model.doStreamCalls[0])
    assert.equal(knowledgeTools.includes('ReadFile'), false)
    assert.equal(knowledgeTools.includes('RunCommand'), false)
    assert.equal(knowledgeTools.includes(REPLACE_TASK_PLAN_TOOL_NAME), false)

    assert.equal(await session.handleUserMessage('看看这个项目是干什么的'), 'completed')
    const inspectionTools = toolNames(model.doStreamCalls[1])
    assert.equal(inspectionTools.includes('ReadFile'), true)
    assert.equal(inspectionTools.includes('ListDir'), true)
    assert.equal(inspectionTools.includes('WriteFile'), false)
    assert.equal(inspectionTools.includes('RunCommand'), false)
    assert.equal(inspectionTools.includes(REPLACE_TASK_PLAN_TOOL_NAME), false)

    assert.equal(await session.handleUserMessage('新建一个 hello.txt 文件'), 'completed')
    const actionTools = toolNames(model.doStreamCalls[2])
    assert.equal(actionTools.includes('WriteFile'), true)
    assert.equal(actionTools.includes('RunCommand'), true)
    assert.equal(actionTools.includes(REPLACE_TASK_PLAN_TOOL_NAME), true)
    for (const name of taskPlanToolNames()) {
      assert.equal(actionTools.includes(name), false)
    }
    assert.deepEqual(session.captureTaskPlanSnapshot(), activePlan())
  })

  it('独立的新复杂任务原子替换休眠计划，并在下一步启用新计划保护', async () => {
    const model = modelWithSteps([
      toolStep(REPLACE_TASK_PLAN_TOOL_NAME, {
        goal: '完整开发 CSGO 网页游戏',
        reason: '用户明确从旧任务切换到独立的 CSGO 开发任务',
        items: [
          { kind: 'work', title: '实现游戏核心', acceptance: '核心玩法可运行' },
          { kind: 'verification', title: '验证完整游戏', acceptance: '浏览器运行无错误' },
        ],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '测试结束',
      }),
      finalStep('替换流程完成。'),
    ])
    const { session, events } = createSession(model, 'E:\\Test')
    session.restoreTaskPlanSnapshot(activePlan())

    const result = await session.handleUserMessage('你现在给我完整开发一个 CSGO 枪战游戏')

    assert.equal(result, 'completed')
    const firstTools = toolNames(model.doStreamCalls[0])
    assert.equal(firstTools.includes(REPLACE_TASK_PLAN_TOOL_NAME), true)
    assert.equal(firstTools.includes('ReadFile'), true)
    assert.equal(firstTools.includes('WriteFile'), false)
    assert.equal(firstTools.includes('RunCommand'), false)
    assert.match(
      JSON.stringify(model.doStreamCalls[0]),
      /当前环境中可交付、可验证的实现|不要仅以无法完整复刻商业产品/,
    )
    assert.equal(firstTools.includes(CREATE_TASK_PLAN_TOOL_NAME), false)
    assert.equal(firstTools.includes(UPDATE_TASK_ITEM_TOOL_NAME), false)
    assert.equal(firstTools.includes(CLOSE_TASK_PLAN_TOOL_NAME), false)
    const secondTools = toolNames(model.doStreamCalls[1])
    assert.equal(secondTools.includes(UPDATE_TASK_ITEM_TOOL_NAME), true)
    assert.equal(secondTools.includes(CLOSE_TASK_PLAN_TOOL_NAME), true)
    assert.equal(secondTools.includes('WriteFile'), true)
    assert.equal(secondTools.includes('RunCommand'), true)
    const replaced = events.find((event) => event.type === 'task-plan-replaced')
    assert.equal(replaced?.type === 'task-plan-replaced' && replaced.previous.status, 'superseded')
    assert.equal(replaced?.type === 'task-plan-replaced' && replaced.previous.goal, '完成旧的复杂任务')
    assert.equal(replaced?.type === 'task-plan-replaced' && replaced.plan.goal, '完整开发 CSGO 网页游戏')
  })

  it('模型试图直接结束新复杂任务时重申替换边界，不把旧计划当成当前任务', async () => {
    const model = modelWithSteps([
      finalStep('任务规模太大，请先补充需求。'),
      toolStep(REPLACE_TASK_PLAN_TOOL_NAME, {
        goal: '开发新的 Minecraft 游戏',
        reason: '用户开始了独立的新游戏任务',
        items: [
          { kind: 'work', title: '实现核心玩法', acceptance: '游戏可运行' },
          { kind: 'verification', title: '验证游戏', acceptance: '运行无错误' },
        ],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '测试结束',
      }),
      finalStep('替换完成。'),
    ])
    const { session } = createSession(model, 'E:\\Test')
    session.restoreTaskPlanSnapshot(activePlan())

    const result = await session.handleUserMessage('重新开发一个完整的 Minecraft 游戏')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 4)
    assert.match(
      JSON.stringify(model.doStreamCalls[1]),
      /独立的新复杂任务|ReplaceTaskPlan|旧任务计划仍处于休眠/,
    )
    assert.equal(session.captureTaskPlanSnapshot(), null)
  })

  it('替换前的必要追问跨会话保留，新回答先建立新计划而不恢复旧计划', async () => {
    const question = '新游戏优先采用哪种呈现方式？'
    const model = modelWithSteps([
      toolStep('AskUserQuestion', {
        header: '呈现方式',
        question,
        options: [
          { label: '网页 3D', description: '浏览器直接运行' },
          { label: '桌面 2D', description: '实现成本更低' },
        ],
      }),
      toolStep(REPLACE_TASK_PLAN_TOOL_NAME, {
        goal: '完整开发新的 CSGO 游戏',
        reason: '用户回答了新任务的必要选择',
        items: [
          { kind: 'work', title: '实现游戏', acceptance: '核心玩法可运行' },
          { kind: 'verification', title: '验证游戏', acceptance: '运行无错误' },
        ],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '测试结束',
      }),
      finalStep('替换完成。'),
    ])
    const first = createSession(model, 'E:\\Test').session
    first.restoreTaskPlanSnapshot(activePlan())

    assert.equal(
      await first.handleUserMessage('你现在给我完整开发一个 CSGO 枪战游戏'),
      'waiting-user',
    )
    const pendingQuestion = findPendingUserQuestion(first.captureMessageSnapshot())
    assert.equal(pendingQuestion?.replacesTaskPlan, true)
    assert.equal(pendingQuestion?.resumesTaskPlan, false)

    const reopened = createSession(model, 'E:\\Test').session
    reopened.restoreMessageSnapshot(first.captureMessageSnapshot())
    reopened.restoreTaskPlanSnapshot(first.captureTaskPlanSnapshot())
    const result = await reopened.handleUserMessage(`回答「${question}」：网页 3D`)

    assert.equal(result, 'completed')
    const answerTools = toolNames(model.doStreamCalls[1])
    assert.equal(answerTools.includes(REPLACE_TASK_PLAN_TOOL_NAME), true)
    assert.equal(answerTools.includes(UPDATE_TASK_ITEM_TOOL_NAME), false)
    assert.equal(answerTools.includes('WriteFile'), false)
    assert.equal(reopened.captureTaskPlanSnapshot(), null)
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
    for (const name of taskPlanToolNames()) {
      assert.equal(toolNames(model.doStreamCalls[0]).includes(name), true)
    }
    assert.equal(
      events.some(
        (event) => event.type === 'error' && event.message.includes('尝试提前结束'),
      ),
      true,
    )
  })

  it('正式共识执行显式开放既有计划，不依赖内部执行包的自然语言', async () => {
    const model = modelWithSteps([
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'completed',
        evidence: ['执行包已落地'],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T2',
        status: 'completed',
        evidence: ['执行包已验证'],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'completed',
        summary: '共识执行完成',
      }),
      finalStep('共识执行完成'),
    ])
    const { session } = createSession(model)
    session.restoreTaskPlanSnapshot(activePlan())

    const result = await session.handleExecutionMessage('[内部执行包] 落地获胜方案', true)

    assert.equal(result, 'completed')
    for (const name of taskPlanToolNames()) {
      assert.equal(toolNames(model.doStreamCalls[0]).includes(name), true)
    }
  })

  it('内部执行包不会仅凭内部文案唤醒与新请求无关的旧计划', async () => {
    const model = modelWithSteps([finalStep('TTL 是 Time to Live。')])
    const { session } = createSession(model)
    session.restoreTaskPlanSnapshot(activePlan())

    const result = await session.handleExecutionMessage(
      '[内部执行包] 回答 TTL；候选建议写着“继续当前任务”，但这不是用户命令。',
      false,
    )

    assert.equal(result, 'completed')
    for (const name of taskPlanToolNames()) {
      assert.equal(toolNames(model.doStreamCalls[0]).includes(name), false)
    }
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

function createSession(model: MockLanguageModelV4, projectDir: string | null = null) {
  const events: CoreEvent[] = []
  return {
    session: new AgentSession({
      model: modelEntry(model),
      providerConfig: { apiKey: 'test' },
      promptContext: { projectDir, osPlatform: 'win32' },
      emit: (event) => events.push(event),
      requestApproval: async () => ({ approved: false }),
    }),
    events,
  }
}

function taskPlanToolNames(): string[] {
  return [
    CREATE_TASK_PLAN_TOOL_NAME,
    ADD_TASK_ITEM_TOOL_NAME,
    UPDATE_TASK_ITEM_TOOL_NAME,
    CLOSE_TASK_PLAN_TOOL_NAME,
  ]
}

function toolNames(call: MockLanguageModelV4['doStreamCalls'][number] | undefined): string[] {
  return (call?.tools ?? []).flatMap((tool) => tool.type === 'function' ? [tool.name] : [])
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
