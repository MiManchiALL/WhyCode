import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
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
  CLOSE_TASK_PLAN_TOOL_NAME,
  CREATE_TASK_PLAN_TOOL_NAME,
  createTaskPlanTools,
  RESUME_TASK_PLAN_TOOL_NAME,
  UPDATE_TASK_ITEM_TOOL_NAME,
} from '../tasks/tools.ts'
import { TaskPlanController } from '../tasks/controller.ts'
import { validateToolInput } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('Main 长任务端到端控制', () => {
  it('UpdateTaskItem 只接受扁平严格的新协议', async () => {
    const update = createTaskPlanTools(new TaskPlanController(), {
      isEngaged: () => true,
      onEngagementAction: () => undefined,
    }).find((tool) => tool.name === UPDATE_TASK_ITEM_TOOL_NAME)
    assert.ok(update)
    const accepts = async (input: unknown) => (await validateToolInput(update, input)).success

    assert.equal(await accepts({ item_id: 'T1', status: 'in_progress' }), true)
    assert.equal(await accepts({
      changes: [{ action: 'edit', item_id: 'T2', outcome: '调用方已经统一' }],
      item_id: 'T1',
      status: 'completed',
      evidence: ['验证通过'],
    }), true)
    assert.equal(await accepts({
      transition: { item_id: 'T1', status: 'in_progress' },
    }), false)
    assert.equal(await accepts({
      item_id: 'T1', status: 'completed',
    }), false)
    assert.equal(await accepts({
      item_id: 'T1', status: 'blocked',
      blocked_reason: '旧原因',
    }), false)
    assert.equal(await accepts({ evidence: ['游离证据'] }), false)
  })

  it('任务工具在受管默认工作区中可用，计划状态随每步注入并在最终正文自然关闭', async () => {
    const model = modelWithSteps([
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '交付可靠功能',
        items: [
          { kind: 'work', outcome: '核心功能已经实现' },
          { kind: 'work', outcome: '相关调用已经统一' },
          { kind: 'verification', outcome: '完整功能通过验证' },
        ],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'in_progress',
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'completed',
        evidence: ['实现文件已检查'],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T2',
        status: 'in_progress',
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T2',
        status: 'completed',
        evidence: ['调用检查通过'],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T3',
        status: 'in_progress',
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T3',
        status: 'completed',
        evidence: ['自动化测试通过'],
      }),
      finalStep('全部完成'),
    ])
    const { session, events } = createSession(model)

    const result = await session.handleUserMessage('完成复杂任务')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 8)
    const taskTools = JSON.stringify(model.doStreamCalls[0]?.tools)
    assert.match(taskTools, /item_id/)
    assert.doesNotMatch(taskTools, /transition/)
    assert.match(JSON.stringify(model.doStreamCalls[1]), /交付可靠功能|T1/)
    assert.match(JSON.stringify(model.doStreamCalls[1]), /whycode-task-state/)
    assert.match(JSON.stringify(model.doStreamCalls[1]), /whycode-task-execution/)
    assert.match(JSON.stringify(model.doStreamCalls[7]), /active_plan/)
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[7]), /historical_plans/)
    assert.match(JSON.stringify(model.doStreamCalls[7]), /completed/)
    for (const call of model.doStreamCalls.slice(1)) {
      assert.deepEqual(call.tools, model.doStreamCalls[0]?.tools)
    }
    const updates = events.filter((event) => event.type === 'task-plan-updated')
    assert.equal(updates.length, 8)
    assert.equal(updates.at(-1)?.type === 'task-plan-updated' && updates.at(-1)?.plan.status, 'completed')
  })

  it('模型自然给出最终正文时结束未完成计划，只发布一次零状态边界', async () => {
    const model = modelWithSteps([
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '不能半途结束',
        items: [
          { kind: 'work', outcome: '主要功能已经实现' },
          { kind: 'work', outcome: '相关调用已经完成' },
          { kind: 'verification', outcome: '整体行为通过验证' },
        ],
      }),
      finalStep('已经完成'),
      finalStep('普通回答一'),
      finalStep('普通回答二'),
    ])
    const { session, events } = createSession(model)

    const result = await session.handleUserMessage('执行但不要漏项')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 2)
    assert.equal(events.some((event) => event.type === 'error'), false)
    assert.equal(session.captureTaskStateSnapshot()?.activePlan, null)
    assert.equal(countClosedTaskStateReminders(session.captureMessageSnapshot()), 1)
    const updates = events.filter((event) => event.type === 'task-plan-updated')
    assert.equal(updates.at(-1)?.type === 'task-plan-updated' && updates.at(-1)?.plan.status, 'ended')

    assert.equal(await session.handleUserMessage('后续普通问题一'), 'completed')
    assert.equal(countClosedTaskStateReminders(session.captureMessageSnapshot()), 1)
    assert.equal(await session.handleUserMessage('后续普通问题二'), 'completed')
    assert.equal(countClosedTaskStateReminders(session.captureMessageSnapshot()), 1)
  })

  it('engaged 计划连续十个模型步骤未更新时注入轻提醒', async () => {
    const model = modelWithSteps([
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '完成长时间排查',
        items: [
          { kind: 'work', outcome: '问题根因已经确认并修复' },
          { kind: 'work', outcome: '受影响路径已经统一' },
          { kind: 'verification', outcome: '修复通过整体验证' },
        ],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T1',
        status: 'in_progress',
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
        status: 'in_progress',
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T2',
        status: 'completed',
        evidence: ['调用路径检查通过'],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T3',
        status: 'in_progress',
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T3',
        status: 'completed',
        evidence: ['测试通过'],
      }),
      finalStep('完成。'),
    ])
    const { session } = createSession(model, 'E:\\workspace\\WhyCode')

    assert.equal(await session.handleUserMessage('完成一项复杂排查'), 'completed')
    assert.match(JSON.stringify(model.doStreamCalls[12]), /已有 10 个模型步骤没有更新/)
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[11]), /已有 10 个模型步骤没有更新/)
  })

  it('engaged 自动压缩保留 canonical TaskState 和同一执行 continuation', async () => {
    const model = compactingModel([
      finalStep('已验证压缩续跑。'),
    ])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())
    session.restoreMessageSnapshot([
      { role: 'user', content: '执行一个很长的计划' },
      { role: 'assistant', content: 'x'.repeat(360_000) },
      createUserQuestionMarker({
        id: 'compact-plan-question',
        questions: [{
          header: '运行系统',
          question: '你使用哪个系统？',
          options: [
            { label: 'Windows', description: '按 Windows 处理' },
            { label: 'macOS', description: '按 macOS 处理' },
          ],
        }],
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

  it('dormant、interrupted 和手动压缩都不会伪造 execution continuation', async () => {
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
      { role: 'assistant', content: '此前回答'.repeat(20_000) },
    ])
    await session.compactNow()
    const manualContext = JSON.stringify(session.captureMessageSnapshot())
    assert.match(manualContext, /whycode-task-state/)
    assert.doesNotMatch(manualContext, /whycode-task-continuation/)
  })

  it('完整压缩只重建曾产生过的当前 TaskState', async () => {
    const closedModel = compactingModel([])
    const { session: closedSession } = createSession(closedModel)
    closedSession.restoreTaskStateSnapshot({
      version: 4,
      activePlan: null,
      resumeRequired: false,
      interruptionReason: null,
    })
    closedSession.restoreMessageSnapshot([
      { role: 'user', content: '手动压缩已结束任务的长对话' },
      { role: 'assistant', content: '此前回答'.repeat(20_000) },
    ])

    await closedSession.compactNow()

    const closedContext = JSON.stringify(closedSession.captureMessageSnapshot())
    assert.match(closedContext, /whycode-task-state/)
    assert.match(closedContext, /active_plan\\?\":null/)
    assert.doesNotMatch(closedContext, /whycode-task-continuation/)

    const untouchedModel = compactingModel([])
    const { session: untouchedSession } = createSession(untouchedModel)
    untouchedSession.restoreMessageSnapshot([
      { role: 'user', content: '手动压缩从未建立计划的长对话' },
      { role: 'assistant', content: '此前回答'.repeat(20_000) },
    ])

    await untouchedSession.compactNow()

    assert.doesNotMatch(
      JSON.stringify(untouchedSession.captureMessageSnapshot()),
      /whycode-task-state/,
    )
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
    assert.doesNotMatch(request, /剩余核心功能已经完成|相关调用路径已经统一|整体结果通过验证/)
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

  it('独立新目标按结束、扫描、创建切换，状态不保存历史计划', async () => {
    const model = modelWithSteps([
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {}),
      toolStep('ListDir', { path: '.', limit: 20 }),
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '完整开发 CSGO 网页游戏',
        items: [
          { kind: 'work', outcome: '游戏核心玩法已经可运行' },
          { kind: 'work', outcome: '界面与交互已经完整' },
          { kind: 'verification', outcome: '浏览器整体验证无错误' },
        ],
      }),
      finalStep('切换流程完成。'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage(
      '放弃当前旧任务，切换到完整开发一个 CSGO 枪战游戏',
    )

    assert.equal(result, 'completed')
    const updates = events.filter((event) => event.type === 'task-plan-updated')
    assert.deepEqual(updates.map((event) => event.plan.status), [
      'ended',
      'active',
      'ended',
    ])
    const state = session.captureTaskStateSnapshot()!
    assert.equal(state.activePlan, null)
    assert.deepEqual(Object.keys(state).sort(), [
      'activePlan',
      'interruptionReason',
      'resumeRequired',
      'version',
    ])
    assert.equal(events.some((event) => event.type === 'task-plan-restored'), false)
  })

  it('UpdateTaskItem 在一个稳定步骤内同时修订路线并推进状态', async () => {
    const model = modelWithSteps([
      toolStep(RESUME_TASK_PLAN_TOOL_NAME, { plan_id: activePlan().id }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        changes: [
          { action: 'edit', item_id: 'T2', outcome: '所有调用路径已经统一' },
          { action: 'add', outcome: '迁移后的数据已经收口', after_item_id: 'T2' },
        ],
        item_id: 'T1',
        status: 'completed',
        evidence: ['当前里程碑已经验证'],
      }),
      finalStep('计划路线已经更新。'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    assert.equal(await session.handleUserMessage('继续，并按最新发现调整后续路线'), 'completed')
    const changed = events.findLast((event) =>
      event.type === 'task-plan-updated' && event.plan.status === 'active')
    assert.ok(changed?.type === 'task-plan-updated' && changed.plan.status === 'active')
    assert.equal(changed.plan.items.find((item) => item.id === 'T2')?.outcome, '所有调用路径已经统一')
    assert.equal(changed.plan.items.find((item) => item.id === 'T2')?.status, 'pending')
    assert.equal(changed.plan.items.some((item) => item.id === 'T4'), true)
  })

  it('模型选择只回答新请求时，代码不会强制切换或唤醒旧计划', async () => {
    const model = modelWithSteps([finalStep('我先给出实现范围和可选方案。')])
    const { session } = createSession(model, 'E:\\Test')
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('重新开发一个完整的 Minecraft 游戏')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
  })

  it('目标切换确认跨会话保留，明确回答后结束旧计划并重新创建', async () => {
    const question = '是否放弃当前任务并改做 CSGO？'
    const model = modelWithSteps([
      toolStep('AskUserQuestion', {
        questions: [{
          header: '切换任务',
          question,
          options: [
            { label: '确认切换', description: '结束当前计划并建立 CSGO 计划' },
            { label: '保留旧任务', description: '继续保留当前活动计划' },
          ],
        }],
      }),
      toolStep(CLOSE_TASK_PLAN_TOOL_NAME, {}),
      toolStep('ListDir', { path: '.', limit: 20 }),
      toolStep(CREATE_TASK_PLAN_TOOL_NAME, {
        goal: '完整开发新的 CSGO 游戏',
        items: [
          { kind: 'work', outcome: '游戏核心玩法已经可运行' },
          { kind: 'work', outcome: '界面与交互已经完整' },
          { kind: 'verification', outcome: '游戏整体运行无错误' },
        ],
      }),
      finalStep('切换完成。'),
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

  it('恢复计划在本轮重新接合后由最终正文自然结束', async () => {
    const model = modelWithSteps([
      toolStep(RESUME_TASK_PLAN_TOOL_NAME, {
        plan_id: activePlan().id,
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        changes: [{
          action: 'edit',
          item_id: 'T1',
          outcome: '剩余核心功能已经按当前代码完成',
        }],
      }),
      finalStep('过早结束一'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('继续刚才的任务')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 3)
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[0]))
    assertStableTaskPlanTools(toolNames(model.doStreamCalls[1]))
    assert.match(JSON.stringify(model.doStreamCalls[1]), /剩余核心功能已经完成|整体结果通过验证/)
    assert.equal(events.some((event) => event.type === 'error'), false)
    assert.equal(session.captureTaskStateSnapshot()?.activePlan, null)
    const terminal = events.findLast((event) => event.type === 'task-plan-updated')
    assert.equal(terminal?.type === 'task-plan-updated' && terminal.plan.status, 'ended')
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
        status: 'in_progress',
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T2',
        status: 'completed',
        evidence: ['调用路径已收口'],
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T3',
        status: 'in_progress',
      }),
      toolStep(UPDATE_TASK_ITEM_TOOL_NAME, {
        item_id: 'T3',
        status: 'completed',
        evidence: ['执行包已验证'],
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
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[0]), /剩余核心功能已经完成|整体结果通过验证/)
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
        outcome: '剩余核心功能已经完成',
        status: 'in_progress',
        evidence: [],
      },
      {
        id: 'T2',
        kind: 'work',
        outcome: '相关调用路径已经统一',
        status: 'pending',
        evidence: [],
      },
      {
        id: 'T3',
        kind: 'verification',
        outcome: '整体结果通过验证',
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
    resumeRequired: false,
    interruptionReason: null,
  }
}

function createSession(model: MockLanguageModelV4, projectDir: string = process.cwd()) {
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

function countClosedTaskStateReminders(messages: ModelMessage[]): number {
  return messages.filter((message) =>
    typeof message.content === 'string'
    && message.content.includes('<whycode-task-state')
    && message.content.includes('"active_plan":null'),
  ).length
}

function assertStableTaskPlanTools(names: string[]): void {
  assert.equal(names.includes('ReplaceTaskPlan'), false)
  assert.equal(names.includes('AddTaskItem'), false)
  for (const name of [
    CREATE_TASK_PLAN_TOOL_NAME,
    RESUME_TASK_PLAN_TOOL_NAME,
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
