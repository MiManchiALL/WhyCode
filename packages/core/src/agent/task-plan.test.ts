import { questionResult, answerFirstQuestion } from '../test-fixtures/user-questions.ts'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { simulateReadableStream, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { CoreEvent } from '../events.ts'
import type { ModelEntry } from '../providers/registry.ts'
import {
  pendingUserQuestions,
} from '../context/question-state.ts'
import {
  activeTaskPlanSchema,
  type ActiveTaskPlan,
  type TaskPlanState,
} from '../tasks/types.ts'
import { createTaskPlanTool, TASK_PLAN_TOOL_NAME } from '../tasks/tools.ts'
import { isTaskProgressReminder } from '../tasks/reminder.ts'
import { TaskPlanController } from '../tasks/controller.ts'
import { validateToolInput } from '../tools/tool.ts'
import { AgentSession } from './session.ts'

describe('Main 长任务端到端控制', () => {
  it('按操作校验计划参数，更新项时校验状态和完成证据', async () => {
    const tool = createTaskPlanTool(new TaskPlanController(), () => undefined)
    for (const input of [
      {}, { action: 'create' }, { action: 'update' }, { action: 'close', goal: '其它目标' },
      { action: 'update', goal: '其它目标', changes: [{ action: 'delete', item_id: 'T1' }] },
    ]) {
      assert.equal((await validateToolInput(tool, input)).success, false)
    }
    const accepts = async (changes: unknown[]) => (await validateToolInput(tool, { action: 'update', changes })).success
    const edit = { action: 'edit', item_id: 'T1' }
    assert.equal(await accepts([
      { ...edit, status: 'completed', evidence: ['核心测试通过'] },
      { ...edit, item_id: 'T2', status: 'in_progress' },
    ]), true)
    assert.equal(await accepts([{ ...edit, status: 'completed' }]), false)
    assert.equal(await accepts([{ ...edit, status: 'completed', evidence: ['  '] }]), false)
    assert.equal(await accepts([{ ...edit, status: 'in_progress', evidence: ['游离证据'] }]), false)
    assert.equal(await accepts([edit]), false)
  })

  it('并行里程碑最后一次工具更新即关闭，后续模型请求和界面看到同一结果', async () => {
    const model = modelWithSteps([
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'create',
        goal: '交付可靠功能',
        items: [
          { kind: 'work', outcome: '核心功能已经实现', status: 'in_progress' },
          { kind: 'work', outcome: '相关调用已经统一', status: 'in_progress' },
          { kind: 'verification', outcome: '完整功能通过验证' },
        ],
      }),
      toolStep(TASK_PLAN_TOOL_NAME, { action: 'update', changes: [
        { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['实现文件已检查'] },
        { action: 'edit', item_id: 'T2', status: 'completed', evidence: ['调用检查通过'] },
        { action: 'edit', item_id: 'T3', status: 'in_progress' },
      ] }),
      toolStep(TASK_PLAN_TOOL_NAME, { action: 'update', changes: [
        { action: 'edit', item_id: 'T3', status: 'completed', evidence: ['自动化测试通过'] },
      ] }),
      finalStep('全部完成'),
    ])
    const { session, events } = createSession(model)
    assert.equal(await session.handleUserMessage('完成复杂任务'), 'completed')
    assert.equal(model.doStreamCalls.length, 4)
    const updates = events.filter(event => event.type === 'task-plan-updated')
    assert.deepEqual(updates.map(event => event.plan.status), ['active', 'active', 'completed'])
    assert.deepEqual(updates.map(event => event.plan.items.map(item => item.status)), [
      ['in_progress', 'in_progress', 'pending'],
      ['completed', 'completed', 'in_progress'],
      ['completed', 'completed', 'completed'],
    ])
    const results = events.filter(event => event.type === 'tool-end')
    assert.equal(results.length, 3)
    assert.deepEqual(results.map(event => event.result), [
      '已建立计划「交付可靠功能」，进度 0/3。\nT1 [in_progress] 核心功能已经实现\nT2 [in_progress] 相关调用已经统一\nT3 [pending] 完整功能通过验证（整体验证）',
      '已完成 T1「核心功能已经实现」。\n已完成 T2「相关调用已经统一」。\n已开始 T3，进度 2/3。进行中：T3「完整功能通过验证」。',
      '计划已完成并自动关闭，进度 3/3。',
    ])
    for (const [index, event] of results.entries()) {
      assert.equal(event.isError, false)
      const next = model.doStreamCalls[index + 1]!
      assert.deepEqual(next.tools, model.doStreamCalls[0]!.tools)
      const part = next.prompt.flatMap(message => message.role === 'tool' ? message.content : [])
        .find(part => part.type === 'tool-result' && part.toolCallId === event.toolUseId)
      assert.ok(part?.type === 'tool-result')
      assert.deepEqual(part.output, { type: 'text', value: event.result })
    }
    assert.deepEqual(updates[2]!.plan.items.map(item => item.evidence),
      [['实现文件已检查'], ['调用检查通过'], ['自动化测试通过']])
    assert.deepEqual(session.captureTaskStateSnapshot(), { version: 3, activePlan: null })
  })

  it('无效编号与提前关闭的回执原样进入模型请求和压缩历史', async () => {
    const model = compactingModel([
      toolStep(TASK_PLAN_TOOL_NAME, { action: 'update', changes: [{ action: 'delete', item_id: 'T9' }] }),
      toolStep(TASK_PLAN_TOOL_NAME, { action: 'close' }),
      finalStep('已结束旧计划。'),
    ])
    const { session, events } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())
    assert.equal(await session.handleUserMessage('原计划已经不适用'), 'completed')
    const expectedError = 'item_not_found：任务项不存在：T9。当前计划项：T1「剩余核心功能已经完成」、T2「相关调用路径已经统一」、T3「整体结果通过验证」。'
    const error = model.doStreamCalls[1]!.prompt.findLast(message => message.role === 'tool')?.content[0]
    assert.ok(error?.type === 'tool-result')
    assert.deepEqual(error.output, { type: 'error-text', value: expectedError })
    const receipts = events.filter(event => event.type === 'tool-end')
    assert.deepEqual(receipts.map(event => [event.isError, event.result]),
      [[true, expectedError], [false, '计划已按要求结束，已完成 0/3。']])
    assert.equal(session.captureTaskStateSnapshot()?.activePlan, null)

    await session.compactNow()
    const results = model.doGenerateCalls[0]!.prompt.flatMap(message => message.role === 'tool' ? message.content : [])
      .filter(part => part.type === 'tool-result')
    assert.deepEqual(results.map(part => part.output), [error.output, { type: 'text', value: receipts[1]!.result }])
  })

  it('创建失败后，模型可在下一步骤更新原活动计划', async () => {
    const model = modelWithSteps([
      toolStep(TASK_PLAN_TOOL_NAME, { action: 'create', goal: '新目标', items: [] }),
      toolStep(TASK_PLAN_TOOL_NAME, { action: 'update', changes: [
        { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['原计划第一项验证通过'] },
      ] }),
      finalStep('原计划进度已更新。'),
    ])
    const { session } = createSession(model)
    const original = activePlan()
    session.restoreTaskStateSnapshot({ version: original.revision, activePlan: original })
    assert.equal(await session.handleUserMessage('核对计划'), 'completed')
    const plan = session.captureTaskStateSnapshot()?.activePlan
    assert.equal(plan?.id, original.id)
    assert.equal(plan?.items[0]?.status, 'completed')
    assert.deepEqual(plan?.items[0]?.evidence, ['原计划第一项验证通过'])
  })

  it('最终正文与后续普通问答保留未完成计划', async () => {
    const model = modelWithSteps([
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'create',
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
    assert.equal(session.captureTaskStateSnapshot()?.activePlan?.goal, '不能半途结束')
    const updates = events.filter((event) => event.type === 'task-plan-updated')
    assert.deepEqual(updates.map(event => event.plan.status), ['active'])

    assert.equal(await session.handleUserMessage('后续普通问题一'), 'completed')
    assert.equal(await session.handleUserMessage('后续普通问题二'), 'completed')
    assert.deepEqual(session.captureTaskStateSnapshot()?.activePlan, updates[0]!.plan)
  })

  it('连续十个已提交步骤后在请求末尾提醒最新进度', async () => {
    const model = modelWithSteps([
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'create',
        goal: '完成长时间排查',
        items: [
          { kind: 'work', outcome: '问题根因已经确认并修复', status: 'in_progress' },
          { kind: 'work', outcome: '受影响路径已经统一' },
          { kind: 'verification', outcome: '修复通过整体验证' },
        ],
      }),
      ...Array.from(
        { length: 10 },
        (_, offset) => toolStep('ListDir', { path: '.', limit: 1, offset }),
      ),
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'update',
        changes: [
          { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['排查和修复完成'] },
          { action: 'edit', item_id: 'T2', status: 'in_progress' },
        ],
      }),
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'update',
        changes: [
          { action: 'edit', item_id: 'T2', status: 'completed', evidence: ['调用路径检查通过'] },
          { action: 'edit', item_id: 'T3', status: 'in_progress' },
        ],
      }),
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'update',
        changes: [
          { action: 'edit', item_id: 'T3', status: 'completed', evidence: ['测试通过'] },
        ],
      }),
      finalStep('完成。'),
    ])
    const { session } = createSession(model, 'E:\\workspace\\WhyCode')

    assert.equal(await session.handleUserMessage('完成一项复杂排查'), 'completed')
    assert.match(JSON.stringify(model.doStreamCalls[11]), /whycode-task-progress/)
    assert.doesNotMatch(JSON.stringify(model.doStreamCalls[10]), /whycode-task-progress/)
  })

  it('短回合与重启沿用提醒间隔，提醒包含当前清单且不会重复追加', async () => {
    const model = modelWithSteps([
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'create',
        goal: '验收跨回合功能',
        items: [
          { kind: 'work', outcome: '实现已提交', status: 'in_progress' },
          { kind: 'work', outcome: '调用已接通' },
          { kind: 'verification', outcome: '验收已完成' },
        ],
      }),
      toolStep(TASK_PLAN_TOOL_NAME, { action: 'update', changes: [
        { action: 'add', after_item_id: 'T1', outcome: '旧配置可用' },
        { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['提交通过检查'] },
        { action: 'edit', item_id: 'T2', status: 'in_progress' },
      ] }),
      ...Array.from({ length: 10 }, () => finalStep('已回复。')),
    ])
    const { session } = createSession(model)
    await session.handleUserMessage('开始验收')
    for (let i = 1; i < 10; i++) await session.handleUserMessage('继续讨论')
    assert.equal(session.captureMessageSnapshot().some(isTaskProgressReminder), false)

    const nextModel = modelWithSteps([finalStep('已查看。'), finalStep('已回复。')])
    const reopened = createSession(nextModel).session
    reopened.restoreMessageSnapshot(session.captureMessageSnapshot())
    reopened.restoreTaskStateSnapshot(session.captureTaskStateSnapshot()!)
    await reopened.handleUserMessage('还剩哪些工作')
    const tail = JSON.stringify(nextModel.doStreamCalls[0]?.prompt.at(-1))
    assert.ok(tail.includes('这是当前任务计划，仅作进度参考。请结合最新上下文关注任务进展，并在有实际进展时适时更新。'))
    const reminders = reopened.captureMessageSnapshot().filter(isTaskProgressReminder)
    assert.equal(reminders.length, 1)
    const body = String(reminders[0]!.content).split('\n')[2]!
    assert.deepEqual(JSON.parse(body), {
      goal: '验收跨回合功能',
      items: [
        { id: 'T1', status: 'completed', outcome: '实现已提交' },
        { id: 'T2', status: 'pending', outcome: '旧配置可用' },
        { id: 'T3', status: 'in_progress', outcome: '调用已接通' },
        { id: 'T4', status: 'pending', outcome: '验收已完成' },
      ],
    })
    await reopened.handleUserMessage('换个问题')
    assert.doesNotMatch(JSON.stringify(nextModel.doStreamCalls[1]?.prompt.at(-1)), /whycode-task-progress/)
    assert.equal(reopened.captureMessageSnapshot().filter(isTaskProgressReminder).length, 1)
  })

  it('自动压缩重建最新任务计划并保留用户回答', async () => {
    const model = compactingModel([
      finalStep('已验证压缩续跑。'),
    ])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())
    session.restoreMessageSnapshot([
      { role: 'user', content: '执行一个很长的计划' },
      ...Array.from({ length: 3 }, (): ModelMessage => ({ role: 'assistant', content: 'x'.repeat(120_000) })),
      questionResult({
        id: 'compact-plan-question',
        questions: [{
          header: '运行系统',
          question: '你使用哪个系统？',
          options: [
            { label: 'Windows', description: '按 Windows 处理' },
            { label: 'macOS', description: '按 macOS 处理' },
          ],
        }],
      }),
    ])
    const answer = '回答「你使用哪个系统？」：Windows'

    assert.equal(await answerFirstQuestion(session, 'Windows'), 'completed')
    const request = JSON.stringify(model.doStreamCalls[0]?.prompt)
    assert.match(request, /whycode-compact-summary/)
    assert.match(request, /当前任务计划「完成旧的复杂任务」，进度 0\/3。/)
    assert.doesNotMatch(request, new RegExp(activePlan().id))
    assert.ok(request.indexOf('当前任务计划「') < request.indexOf(answer))
    assert.doesNotMatch(request, /刚刚压缩完成，继续/)
  })

  it('手动压缩保留活动计划', async () => {
    const manualModel = compactingModel([])
    const { session } = createSession(manualModel)
    const state = activeState()
    Object.assign(state.activePlan!.items[0]!, { status: 'completed', evidence: ['长测试的独立证据'] })
    session.restoreTaskStateSnapshot(state)
    session.restoreMessageSnapshot([
      { role: 'user', content: '手动压缩此前对话' },
      { role: 'assistant', content: '此前回答'.repeat(20_000) },
    ])
    await session.compactNow()
    const manualContext = JSON.stringify(session.captureMessageSnapshot())
    assert.match(manualContext, /当前任务计划「完成旧的复杂任务」，进度 1\/3。/)
    assert.match(manualContext, /T1 \[completed\] 剩余核心功能已经完成/)
    assert.match(manualContext, /T3 \[pending\] 整体结果通过验证（整体验证）/)
    assert.doesNotMatch(manualContext, /长测试的独立证据|active_plan|revision/)
  })

  it('完整压缩只重建曾产生过的当前 TaskState', async () => {
    const closedModel = compactingModel([])
    const { session: closedSession } = createSession(closedModel)
    closedSession.restoreTaskStateSnapshot({
      version: 4,
      activePlan: null,
    })
    closedSession.restoreMessageSnapshot([
      { role: 'user', content: '手动压缩已结束任务的长对话' },
      { role: 'assistant', content: '此前回答'.repeat(20_000) },
    ])

    await closedSession.compactNow()

    const closedContext = JSON.stringify(closedSession.captureMessageSnapshot())
    assert.match(closedContext, /当前没有活动计划。/)

    const untouchedModel = compactingModel([])
    const { session: untouchedSession } = createSession(untouchedModel)
    untouchedSession.restoreMessageSnapshot([
      { role: 'user', content: '手动压缩从未建立计划的长对话' },
      { role: 'assistant', content: '此前回答'.repeat(20_000) },
    ])

    await untouchedSession.compactNow()

    assert.doesNotMatch(
      JSON.stringify(untouchedSession.captureMessageSnapshot()),
      /当前任务计划「|当前没有活动计划/,
    )
  })

  it('自然语言暂停不需要计划工具，活动计划保持保存', async () => {
    const model = modelWithSteps([finalStep('好的，当前任务先暂停。')])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('先暂停，不要放弃计划')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assert.ok(toolNames(model.doStreamCalls[0]).includes(TASK_PLAN_TOOL_NAME))
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
    assert.match(request, /剩余核心功能已经完成/)
    const names = toolNames(model.doStreamCalls[0])
    assert.ok(names.includes(TASK_PLAN_TOOL_NAME))
  })

  it('只咨询方案时保留已有计划', async () => {
    const model = modelWithSteps([finalStep('可以先比较两种方案，再由你决定。')])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('不用外部依赖是不是会好一点，你觉得呢')

    assert.equal(result, 'completed')
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
    assert.ok(toolNames(model.doStreamCalls[0]).includes(TASK_PLAN_TOOL_NAME))
  })

  it('已有计划时提供完整普通工具，是否使用由模型按语义决定', async () => {
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
    assert.ok(knowledgeTools.includes(TASK_PLAN_TOOL_NAME))

    assert.equal(await session.handleUserMessage('看看这个项目是干什么的'), 'completed')
    const inspectionTools = toolNames(model.doStreamCalls[1])
    assertOrdinaryProjectTools(inspectionTools)
    assert.ok(inspectionTools.includes(TASK_PLAN_TOOL_NAME))

    assert.equal(await session.handleUserMessage('新建一个 hello.txt 文件'), 'completed')
    const actionTools = toolNames(model.doStreamCalls[2])
    assertOrdinaryProjectTools(actionTools)
    assert.ok(actionTools.includes(TASK_PLAN_TOOL_NAME))
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

  it('创建新目标只提交新计划，状态和工具返回不包含旧目标', async () => {
    const model = modelWithSteps([
      toolStep('ListDir', { path: '.', limit: 20 }),
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'create',
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
    assert.deepEqual(updates.map(event => event.plan.status), ['active'])
    assert.equal(session.captureTaskStateSnapshot()?.activePlan?.goal, '完整开发 CSGO 网页游戏')
    const created = events.findLast(event => event.type === 'tool-end')
    assert.ok(created?.type === 'tool-end' && !created.isError && typeof created.result === 'string')
    assert.match(created.result, /已建立计划「完整开发 CSGO 网页游戏」/)
    assert.doesNotMatch(created.result, /旧的复杂任务|覆盖|替换/)
    assert.equal(events.some((event) => event.type === 'task-plan-restored'), false)
  })

  it('批量更新在一个稳定步骤内同时修订路线并推进状态', async () => {
    const model = modelWithSteps([
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'update',
        changes: [
          { action: 'edit', item_id: 'T2', outcome: '所有调用路径已经统一', status: 'in_progress' },
          { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['当前里程碑已经验证'] },
          { action: 'add', outcome: '迁移后的数据已经收口', after_item_id: 'T2' },
        ],
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
    assert.equal(changed.plan.items.find((item) => item.id === 'T2')?.status, 'in_progress')
    assert.equal(changed.plan.items[2]?.outcome, '迁移后的数据已经收口')
  })

  it('模型选择只回答新请求时，代码不会强制切换或唤醒旧计划', async () => {
    const model = modelWithSteps([finalStep('我先给出实现范围和可选方案。')])
    const { session } = createSession(model, 'E:\\Test')
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleUserMessage('重新开发一个完整的 Minecraft 游戏')

    assert.equal(result, 'completed')
    assert.equal(model.doStreamCalls.length, 1)
    assert.ok(toolNames(model.doStreamCalls[0]).includes(TASK_PLAN_TOOL_NAME))
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
  })

  it('重启后回答此前的问题可以直接创建替代计划', async () => {
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
      finalStep('请确认是否切换任务。'),
      toolStep('ListDir', { path: '.', limit: 20 }),
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'create',
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
    const [pendingQuestion] = pendingUserQuestions(first.captureMessageSnapshot())
    assert.equal(pendingQuestion?.item.question, question)

    const reopened = createSession(model, 'E:\\Test').session
    reopened.restoreMessageSnapshot(first.captureMessageSnapshot())
    reopened.restoreTaskStateSnapshot(first.captureTaskStateSnapshot()!)
    const result = await answerFirstQuestion(reopened, '确认切换')

    assert.equal(result, 'completed')
    const answerTools = toolNames(model.doStreamCalls[2])
    assert.ok(answerTools.includes(TASK_PLAN_TOOL_NAME))
    assertOrdinaryProjectTools(answerTools)
    assert.equal(reopened.captureTaskStateSnapshot()?.activePlan?.goal, '完整开发新的 CSGO 游戏')
  })

  it('正式共识执行可以直接更新既有计划', async () => {
    const model = modelWithSteps([
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'update',
        changes: [
          { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['执行包已落地'] },
          { action: 'edit', item_id: 'T2', status: 'in_progress' },
        ],
      }),
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'update',
        changes: [
          { action: 'edit', item_id: 'T2', status: 'completed', evidence: ['调用路径已收口'] },
          { action: 'edit', item_id: 'T3', status: 'in_progress' },
        ],
      }),
      toolStep(TASK_PLAN_TOOL_NAME, {
        action: 'update',
        changes: [
          { action: 'edit', item_id: 'T3', status: 'completed', evidence: ['执行包已验证'] },
        ],
      }),
      finalStep('共识执行完成'),
    ])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleExecutionMessage('[内部执行包] 落地获胜方案')

    assert.equal(result, 'completed')
    assert.equal(session.captureTaskStateSnapshot()?.activePlan, null)
    assert.ok(toolNames(model.doStreamCalls[0]).includes(TASK_PLAN_TOOL_NAME))
    assert.ok(toolNames(model.doStreamCalls[1]).includes(TASK_PLAN_TOOL_NAME))
  })

  it('内部执行包只回答用户问题时保留未完成计划', async () => {
    const model = modelWithSteps([finalStep('TTL 是 Time to Live。')])
    const { session } = createSession(model)
    session.restoreTaskStateSnapshot(activeState())

    const result = await session.handleExecutionMessage(
      '[内部执行包] 回答 TTL；候选建议写着“继续当前任务”，但这不是用户命令。',
    )

    assert.equal(result, 'completed')
    assert.ok(toolNames(model.doStreamCalls[0]).includes(TASK_PLAN_TOOL_NAME))
    assert.deepEqual(session.captureTaskStateSnapshot(), activeState())
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
