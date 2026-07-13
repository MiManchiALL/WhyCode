import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import {
  createUserQuestionMarker,
  findPendingUserQuestion,
} from '../tasks/answer-resume.ts'
import {
  activeTaskPlanSchema,
  type ActiveTaskPlan,
  type TaskPlanState,
} from '../tasks/types.ts'
import {
  ADD_TASK_ITEM_TOOL_NAME,
  CLOSE_TASK_PLAN_TOOL_NAME,
  CREATE_TASK_PLAN_TOOL_NAME,
  REPLACE_TASK_PLAN_TOOL_NAME,
  RESUME_TASK_PLAN_TOOL_NAME,
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
    assert.match(JSON.stringify(model.doStreamCalls[1]), /whycode-task-state/)
    assert.match(JSON.stringify(model.doStreamCalls[1]), /whycode-task-execution/)
    assert.match(JSON.stringify(model.doStreamCalls[4]), /active_plan/)
    assert.match(JSON.stringify(model.doStreamCalls[4]), /historical_plans/)
    assert.match(JSON.stringify(model.doStreamCalls[4]), /completed/)
    for (const call of model.doStreamCalls.slice(1)) {
      assert.deepEqual(call.tools, model.doStreamCalls[0]?.tools)
    }
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
    assert.equal(session.captureTaskStateSnapshot()?.activePlan?.goal, '不能半途结束')
  })

  it('engaged 计划连续十个模型步骤未更新时注入轻提醒', async () => {
    const model = modelWithSteps([
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '完成长时间排查',
        items: [
          { kind: 'work', title: '排查问题', acceptance: '找到并修复原因' },
          { kind: 'verification', title: '验证修复', acceptance: '测试通过' },
        ],
      }),
      ...Array.from(
        { length: 10 },
        (_, offset) => toolStep('ListDir', { path: '.', limit: 1, offset }),
      ),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'completed',
        evidence: ['排查和修复完成'],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T2',
        status: 'completed',
        evidence: ['测试通过'],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'completed',
        summary: '排查完成',
      }),
      finalStep('完成。'),
    ])
    const { session } = createSession(model, 'E:\\workspace\\WhyCode')

    assert.equal(await session.handleUserMessage('完成一项复杂排查'), 'completed')
    assert.match(JSON.stringify(model.doStreamCalls[11]), /已有 10 个模型步骤没有更新/)
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[10]), /已有 10 个模型步骤没有更新/)
  })

  it('engaged 自动压缩保留 canonical TaskState 和同一执行 continuation', async () => {
    const model = compactingModel([
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '压缩续跑测试结束',
      }),
      finalStep('已验证压缩续跑。'),
    ])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())
    session.restoreMessageSnapshot([
      { role: 'user', content: '执行一个很长的计划' },
      { role: 'assistant', content: 'x'.repeat(360_000) },
      createUserQuestionMarker({
        id: 'compact-plan-question',
        header: '运行系统',
        question: '你使用哪个系统？',
        options: [
          { label: 'Windows', description: '按 Windows 处理' },
          { label: 'macOS', description: '按 macOS 处理' },
        ],
      }, true),
    ])
    const answer = '回答「你使用哪个系统？」：Windows'

    assert.equal(await session.handleUserMessage(answer), 'completed')
    const request = JSON.stringify(model.doStreamCalls[0]?.prompt)
    assert.match(request, /whycode-compact-summary/)
    assert.match(request, /whycode-task-state/)
    assert.match(request, /whycode-task-continuation/)
    assert.match(request, new RegExp(activePlan().id))
    assert.ok(request.indexOf('whycode-task-continuation') < request.indexOf(answer))
    assert.doesNotMatch(request, /刚刚压缩完成，继续/)
  })

  it('dormant、blocked 和手动压缩都不会伪造 execution continuation', async () => {
    for (const state of [
      activeState(),
      {
        ...activeState(),
        version: activeState().version + 1,
        resumeRequired: true,
        interruptionReason: 'user-cancel' as const,
      },
    ]) {
      const model = compactingModel([finalStep('只回答当前问题。')])
      const { session } = createSession(model)
      session.restoreTaskStateSnapshot(state)
      session.restoreMessageSnapshot([
        { role: 'user', content: '更早的长对话' },
        { role: 'assistant', content: 'x'.repeat(360_000) },
      ])

      assert.equal(await session.handleUserMessage('TTL 是什么'), 'completed')
      const request = JSON.stringify(model.doStreamCalls[0]?.prompt)
      assert.match(request, /whycode-task-state/)
      assert.doesNotMatch(request, /whycode-task-continuation/)
    }

    const manualModel = compactingModel([])
    const { session } = createSession(manualModel)
    session.restoreTaskStateSnapshot(activeState())
    session.restoreMessageSnapshot([
      { role: 'user', content: '手动压缩此前对话' },
      { role: 'assistant', content: '此前回答' },
    ])
    await session.compactNow()
    const manualContext = JSON.stringify(session.captureMessageSnapshot())
    assert.match(manualContext, /whycode-task-state/)
    assert.doesNotMatch(manualContext, /whycode-task-continuation/)
  })

  it('自然语言暂停不需要计划工具，活动计划保持保存', async () => {
    const model = modelWithSteps([finalStep('好的，当前任务先暂停。')])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('先暂停，不要放弃计划')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
  })

  it('恢复的未结束计划不覆盖新用户问题，也不阻止普通回答结束', async () => {
    const model = modelWithSteps([finalStep('你刚刚要求不要安装依赖。')])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('我刚刚说了什么')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assert.equal(session.captureTaskStateSnapshot()?.activePlan?.goal, '完成旧的复杂任务')
    const request = JSON.stringify(model.doStreamCalls[0])
    assert.match(request, /whycode-task-execution-boundary/)
    assert.doesNotMatch(request, /实现剩余功能|验证结果|代码完成|测试通过/)
    assert.ok(request.indexOf('whycode-task-execution-boundary') < request.indexOf('我刚刚说了什么'))
    const names = toolNames(model.doStreamCalls[0])
    assertStableTaskPlanTools(names)
  })

  it('咨询旧任务方案时保持计划休眠，不允许模型误写进度', async () => {
    const model = modelWithSteps([finalStep('可以先比较两种方案，再由你决定。')])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('不用外部依赖是不是会好一点，你觉得呢')

    assert.equal(result, 'completed')
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
  })

  it('休眠计划不按问题类别裁剪普通工具，是否使用由模型按语义决定', async () => {
    const model = modelWithSteps([
      finalStep('《蔚蓝》仍有稳定玩家群体。'),
      finalStep('这是一个游戏项目。'),
      finalStep('可以新建文件。'),
    ])
    const { session } = createSession(model, 'E:\\Test')
    session.restoreTaskStateSnapshot(activeState())

    assert.equal(await session.handleUserMessage('这个游戏目前玩的人多吗'), 'completed')
    const knowledgeTools = toolNames(model.doStreamCalls[0])
    assertOrdinaryProjectTools(knowledgeTools)
    assertStableTaskPlanTools(knowledgeTools)

    assert.equal(await session.handleUserMessage('看看这个项目是干什么的'), 'completed')
    const inspectionTools = toolNames(model.doStreamCalls[1])
    assertOrdinaryProjectTools(inspectionTools)
    assertStableTaskPlanTools(inspectionTools)

    assert.equal(await session.handleUserMessage('新建一个 hello.txt 文件'), 'completed')
    const actionTools = toolNames(model.doStreamCalls[2])
    assertOrdinaryProjectTools(actionTools)
    assertStableTaskPlanTools(actionTools)
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
  })

  it('任务状态不改变连续请求的 System 和工具 Schema', async () => {
    const model = modelWithSteps([finalStep('回答一'), finalStep('回答二')])
    const { session } = createSession(model, 'E:\\workspace\\WhyCode')
    session.restoreTaskStateSnapshot(activeState())

    await session.handleUserMessage('临时问题一')
    await session.handleUserMessage('临时问题二')

    const first = model.doStreamCalls[0]!
    const second = model.doStreamCalls[1]!
    assert.deepEqual(second.tools, first.tools)
    assert.deepEqual(second.prompt[0], first.prompt[0])
    assert.deepEqual(second.prompt.slice(0, first.prompt.length), first.prompt)
  })

  it('独立的新复杂任务原子替换休眠计划，并在下一步启用新计划保护', async () => {
    const model = modelWithSteps([
      toolStep(REPLACE_TASK_PLAN_TOOL_NAME, {
        expected_active_plan_id: activePlan().id,
        replacement_authorized: true,
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
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage(
      '放弃当前旧任务，切换到完整开发一个 CSGO 枪战游戏',
    )

    assert.equal(result, 'completed')
    const firstTools = toolNames(model.doStreamCalls[0])
    assertStableTaskPlanTools(firstTools)
    assertOrdinaryProjectTools(firstTools)
    const secondTools = toolNames(model.doStreamCalls[1])
    assertStableTaskPlanTools(secondTools)
    assertOrdinaryProjectTools(secondTools)
    const replaced = events.find((event) => event.type === 'task-plan-replaced')
    assert.equal(replaced?.type === 'task-plan-replaced' && replaced.previous.status, 'superseded')
    assert.equal(replaced?.type === 'task-plan-replaced' && replaced.previous.goal, '完成旧的复杂任务')
    assert.equal(replaced?.type === 'task-plan-replaced' && replaced.plan.goal, '完整开发 CSGO 网页游戏')
  })

  it('Replace 覆盖未获授权时返回结构化冲突和最新 TaskState', async () => {
    const model = modelWithSteps([
      toolStep(REPLACE_TASK_PLAN_TOOL_NAME, {
        expected_active_plan_id: activePlan().id,
        replacement_authorized: false,
        goal: '尚未确认的新任务',
        reason: '用户只提出了候选目标',
        items: [
          { kind: 'work', title: '实现候选', acceptance: '候选可运行' },
          { kind: 'verification', title: '验证候选', acceptance: '候选通过验证' },
        ],
      }),
      finalStep('当前计划仍保留，请先确认是否覆盖。'),
    ])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    assert.equal(await session.handleUserMessage('也可以考虑另一个复杂任务'), 'completed')
    const resultContext = JSON.stringify(model.doStreamCalls[1]?.prompt)
    assert.match(resultContext, /whycode-task-result/)
    assert.match(resultContext, /active_plan_conflict/)
    assert.match(resultContext, /whycode-task-state/)
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
  })

  it('Resume 与 Replace 同步出现时只提交第一个独占控制动作', async () => {
    const model = modelWithSteps([
      multiToolStep([
        {
          toolName: RESUME_TASK_PLAN_TOOL_NAME,
          input: { plan_id: activePlan().id },
        },
        {
          toolName: REPLACE_TASK_PLAN_TOOL_NAME,
          input: {
            expected_active_plan_id: activePlan().id,
            replacement_authorized: true,
            goal: '不应建立的新计划',
            reason: '同一步冲突测试',
            items: [
              { kind: 'work', title: '错误工作', acceptance: '不应执行' },
              { kind: 'verification', title: '错误验证', acceptance: '不应执行' },
            ],
          },
        },
      ]),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {
        outcome: 'abandoned',
        summary: '测试结束',
      }),
      finalStep('旧计划已按测试要求结束。'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    assert.equal(await session.handleUserMessage('继续旧任务'), 'completed')
    assert.match(JSON.stringify(model.doStreamCalls[1]), /完成旧的复杂任务|实现剩余功能/)
    assert.equal(events.some((event) => event.type === 'task-plan-replaced'), false)
    assert.equal(
      events.some((event) =>
        event.type === 'tool-end'
        && event.isError
        && String(event.result).includes('必须独占一个模型步骤')),
      true,
    )
  })

  it('Replace 独占稳定步骤，旧上下文生成的 Update 不会污染新计划', async () => {
    const model = modelWithSteps([
      multiToolStep([
        {
          toolName: REPLACE_TASK_PLAN_TOOL_NAME,
          input: {
            expected_active_plan_id: activePlan().id,
            replacement_authorized: true,
            goal: '安全建立的新计划',
            reason: '用户明确切换任务',
            items: [
              { kind: 'work', title: '实现新功能', acceptance: '新功能完成' },
              { kind: 'verification', title: '验证新功能', acceptance: '新测试通过' },
            ],
          },
        },
        {
          toolName: UPDATE_TASK_ITEM_TOOL_NAME,
          input: {
            item_id: 'T1',
            status: 'completed',
            evidence: ['这条旧上下文更新必须被拒绝'],
          },
        },
      ]),
      finalStep('过早结束一'),
      finalStep('过早结束二'),
      finalStep('过早结束三'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    assert.equal(await session.handleUserMessage('改做一个新的复杂任务'), 'paused')
    const plan = session.captureTaskStateSnapshot()?.activePlan
    assert.equal(plan?.goal, '安全建立的新计划')
    assert.equal(plan?.items[0]?.status, 'in_progress')
    assert.deepEqual(plan?.items[0]?.evidence, [])
    assert.equal(events.filter((event) => event.type === 'task-plan-replaced').length, 1)
  })

  it('模型选择只回答新请求时，代码不会强制替换或唤醒旧计划', async () => {
    const model = modelWithSteps([finalStep('我先给出实现范围和可选方案。')])
    const { session } = createSession(model, 'E:\\Test')
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('重新开发一个完整的 Minecraft 游戏')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
  })

  it('替换确认跨会话保留，明确回答后原子建立新计划', async () => {
    const question = '是否放弃当前任务并改做 CSGO？'
    const model = modelWithSteps([
      toolStep('AskUserQuestion', {
        header: '替换任务',
        question,
        options: [
          { label: '确认切换', description: '归档当前计划并建立 CSGO 计划' },
          { label: '保留旧任务', description: '不覆盖当前活动计划' },
        ],
      }),
      toolStep(REPLACE_TASK_PLAN_TOOL_NAME, {
        expected_active_plan_id: activePlan().id,
        replacement_authorized: true,
        goal: '完整开发新的 CSGO 游戏',
        reason: '用户在替换确认问题中明确选择了确认切换',
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
    first.restoreTaskStateSnapshot(activeState())

    assert.equal(
      await first.handleUserMessage('你现在给我完整开发一个 CSGO 枪战游戏'),
      'waiting-user',
    )
    const pendingQuestion = findPendingUserQuestion(first.captureMessageSnapshot())
    assert.equal(pendingQuestion?.resumesTaskPlan, false)

    const reopened = createSession(model, 'E:\\Test').session
    reopened.restoreMessageSnapshot(first.captureMessageSnapshot())
    reopened.restoreTaskStateSnapshot(first.captureTaskStateSnapshot()!)
    const result = await reopened.handleUserMessage(`回答「${question}」：确认切换`)

    assert.equal(result, 'completed')
    const answerTools = toolNames(model.doStreamCalls[1])
    assertStableTaskPlanTools(answerTools)
    assertOrdinaryProjectTools(answerTools)
    assert.equal(reopened.captureTaskStateSnapshot()?.activePlan, null)
  })

  it('恢复计划在本轮重新更新后重新启用未完成保护', async () => {
    const model = modelWithSteps([
      toolStep(RESUME_TASK_PLAN_TOOL_NAME, {
        plan_id: activePlan().id,
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'in_progress',
      }),
      finalStep('过早结束一'),
      finalStep('过早结束二'),
      finalStep('过早结束三'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('继续刚才的任务')

    assert.equal(result, 'paused')
    assert.equal(model.doStreamCalls.length, 5)
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[1]))
    assert.match(JSON.stringify(model.doStreamCalls[1]), /实现剩余功能|验证结果/)
    assert.equal(
      events.some(
        (event) => event.type === 'error' && event.message.includes('尝试提前结束'),
      ),
      true,
    )
  })

  it('正式共识执行由模型根据用户语义恢复既有计划', async () => {
    const model = modelWithSteps([
      toolStep(RESUME_TASK_PLAN_TOOL_NAME, {
        plan_id: activePlan().id,
      }),
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
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleExecutionMessage('[内部执行包] 落地获胜方案')

    assert.equal(result, 'completed')
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[1]))
  })

  it('内部执行包不会仅凭内部文案唤醒与新请求无关的旧计划', async () => {
    const model = modelWithSteps([finalStep('TTL 是 Time to Live。')])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleExecutionMessage(
      '[内部执行包] 回答 TTL；候选建议写着“继续当前任务”，但这不是用户命令。',
    )

    assert.equal(result, 'completed')
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[0]), /实现剩余功能|验证结果/)
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

function activeState(): TaskPlanState {
  return {
    version: activePlan().revision,
    activePlan: activePlan(),
    historicalPlans: [],
    resumeRequired: false,
    interruptionReason: null,
  }
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

function assertStableTaskPlanTools(names: string[]): void {
  for (const name of [
    CREATE_TASK_PLAN_TOOL_NAME,
    RESUME_TASK_PLAN_TOOL_NAME,
    REPLACE_TASK_PLAN_TOOL_NAME,
    ADD_TASK_ITEM_TOOL_NAME,
    UPDATE_TASK_ITEM_TOOL_NAME,
    CLOSE_TASK_PLAN_TOOL_NAME,
  ]) {
    assert.equal(names.includes(name), true)
  }
}

function assertOrdinaryProjectTools(names: string[]): void {
  for (const name of ['ReadFile', 'ListDir', 'WriteFile', 'RunCommand']) {
    assert.equal(names.includes(name), true)
  }
}

function toolNames(call: MockLanguageModelV4['doStreamCalls'][number] | undefined): string[] {
  return (call?.tools ?? []).flatMap((tool) => tool.type === 'function' ? [tool.name] : [])
}

type MockOptions = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>

function modelWithSteps(steps: NonNullable<MockOptions['doStream']>): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doStream: steps })
}

function compactingModel(
  steps: NonNullable<MockOptions['doStream']>,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '<summary>压缩后的历史摘要。</summary>' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: usage(),
      warnings: [],
    }),
    doStream: steps,
  })
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

function multiToolStep(calls: Array<{ toolName: string; input: unknown }>) {
  return {
    stream: simulateReadableStream({
      chunks: [
        ...calls.map(({ toolName, input }) => ({
          type: 'tool-call' as const,
          toolCallId: crypto.randomUUID(),
          toolName,
          input: JSON.stringify(input),
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
