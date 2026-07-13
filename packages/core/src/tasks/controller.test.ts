import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TaskPlanController } from './controller.ts'

const drafts = [
  { kind: 'work' as const, title: '实现能力', acceptance: '代码完成' },
  { kind: 'verification' as const, title: '运行验证', acceptance: '测试通过' },
]

describe('Main 长任务计划控制器', () => {
  it('建立计划后只启动第一项，并要求最终验证步骤', () => {
    const { controller } = createController()
    controller.beginStep()

    assert.equal(controller.create('交付功能', drafts).ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'in_progress',
      'pending',
    ])
    const update = controller.commitStep()?.displayUpdate
    assert.equal(update?.kind === 'updated' && update.plan.items.at(-1)?.kind, 'verification')
  })

  it('空白目标、任务项和证据返回结构化校验错误而不是抛异常', () => {
    const { controller } = createController()
    controller.beginStep()
    const blankGoal = controller.create('   ', drafts)
    assert.equal(blankGoal.ok, false)
    assert.equal(blankGoal.ok ? null : blankGoal.error, 'invalid_plan')

    const invalidDraft = controller.create('有效目标', [
      { kind: 'work', title: '   ', acceptance: '完成' },
      drafts[1]!,
    ])
    assert.equal(invalidDraft.ok, false)
    assert.equal(invalidDraft.ok ? null : invalidDraft.error, 'invalid_plan')

    const active = activeController().controller
    active.beginStep()
    const blankEvidence = active.updateItem('T1', 'completed', ['   '])
    assert.equal(blankEvidence.ok, false)
    assert.equal(blankEvidence.ok ? null : blankEvidence.error, 'evidence_required')
  })

  it('完成项必须有证据，并自动推进到下一项', () => {
    const { controller } = activeController()
    controller.beginStep()

    assert.equal(controller.updateItem('T1', 'completed', []).ok, false)
    assert.equal(controller.updateItem('T1', 'completed', ['packages/core 测试通过']).ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'completed',
      'in_progress',
    ])
  })

  it('重复状态不会制造 revision、状态版本或进度提醒重置', () => {
    const { controller } = activeController()
    const initialState = controller.stateSnapshot
    controller.beginStep()

    assert.equal(controller.updateItem('T1', 'in_progress', []).ok, false)
    assert.equal(controller.commitStep(), undefined)
    assert.deepEqual(controller.stateSnapshot, initialState)

    controller.beginStep()
    assert.equal(controller.updateItem('T1', 'blocked', ['日志'], '等待服务').ok, true)
    controller.commitStep()
    const blockedState = controller.stateSnapshot

    controller.beginStep()
    assert.equal(controller.updateItem('T1', 'blocked', ['日志'], '等待服务').ok, false)
    assert.equal(controller.commitStep(), undefined)
    assert.deepEqual(controller.stateSnapshot, blockedState)
  })

  it('未提交的 step 被丢弃时恢复原计划', () => {
    const { controller } = activeController()
    const before = controller.snapshot
    controller.beginStep()
    controller.updateItem('T1', 'blocked', [], '等待用户提供环境')
    controller.discardStep()

    assert.deepEqual(controller.snapshot, before)
  })

  it('新复杂任务原子归档旧计划，丢弃半步时恢复原状态', () => {
    const { controller } = activeController()
    const before = controller.snapshot
    const activeId = controller.snapshot!.id
    controller.beginStep()
    assert.equal(
      controller.replace(activeId, true, '交付新游戏', drafts, '用户明确切换游戏').ok,
      true,
    )
    assert.equal(controller.snapshot?.goal, '交付新游戏')
    controller.discardStep()
    assert.deepEqual(controller.snapshot, before)

    controller.beginStep()
    assert.equal(
      controller.replace(activeId, true, '交付新游戏', drafts, '用户明确切换游戏').ok,
      true,
    )
    const committed = controller.commitStep()
    assert.equal(committed?.displayUpdate.kind, 'replaced')
    if (committed?.displayUpdate.kind !== 'replaced') return
    assert.equal(committed.displayUpdate.previous.status, 'superseded')
    assert.equal(committed.displayUpdate.previous.replacedByPlanId, committed.displayUpdate.plan.id)
    assert.equal(committed.state.activePlan?.goal, '交付新游戏')
    assert.equal(committed.state.historicalPlans[0]?.goal, '交付功能')
  })

  it('计划身份切换必须独占计划变更，替换事件不会被后续更新覆盖', () => {
    const { controller } = activeController()
    const activeId = controller.snapshot!.id
    controller.beginStep()

    assert.equal(
      controller.replace(activeId, true, '交付新游戏', drafts, '用户明确切换游戏').ok,
      true,
    )
    assert.equal(
      controller.updateItem('T1', 'completed', ['旧上下文证据']).ok,
      false,
    )
    const committed = controller.commitStep()
    assert.equal(committed?.displayUpdate.kind, 'replaced')
    assert.equal(committed?.state.activePlan?.items[0]?.status, 'in_progress')

    controller.beginStep()
    assert.equal(controller.updateItem('T1', 'completed', ['新计划证据']).ok, true)
    assert.equal(controller.replace(activeId, true, '不应覆盖', drafts, '同一步二次切换').ok, false)
    assert.equal(controller.commitStep()?.displayUpdate.kind, 'updated')
  })

  it('所有任务和验证完成前拒绝关闭计划', () => {
    const { controller } = activeController()
    controller.beginStep()

    assert.equal(controller.close('completed', '完成').ok, false)
    controller.updateItem('T1', 'completed', ['实现证据'])
    controller.updateItem('T2', 'completed', ['测试证据'])
    assert.equal(controller.close('completed', '全部验证通过').ok, true)
    assert.equal(controller.snapshot, null)
  })

  it('有未完成项时阻止自然收尾，全部受阻时以可继续状态暂停', () => {
    const { controller } = activeController()
    assert.equal(controller.naturalStopDecision().kind, 'continue')

    controller.beginStep()
    controller.updateItem('T1', 'blocked', [], '缺少服务')
    controller.updateItem('T2', 'blocked', [], '依赖同一服务')
    assert.equal(controller.naturalStopDecision().kind, 'pause')
  })

  it('硬中断要求 Resume，恢复后才能更新计划', () => {
    const { controller } = activeController()
    const planId = controller.snapshot!.id
    assert.equal(controller.interrupt('user-cancel')?.resumeRequired, true)

    controller.beginStep()
    assert.equal(controller.updateItem('T1', 'in_progress', []).ok, false)
    assert.equal(controller.resume(planId).ok, true)
    const committed = controller.commitStep()
    assert.equal(committed?.state.resumeRequired, false)
    assert.equal(committed?.state.interruptionReason, null)
  })

  it('Replace 没有明确覆盖授权时返回冲突且不改变状态', () => {
    const { controller } = activeController()
    const before = controller.stateSnapshot
    controller.beginStep()
    const result = controller.replace(
      controller.snapshot!.id,
      false,
      '新任务',
      drafts,
      '用户只提出新目标',
    )
    assert.equal(result.ok, false)
    assert.equal(result.ok ? null : result.error, 'active_plan_conflict')
    assert.deepEqual(controller.stateSnapshot, before)
  })

  it('已有计划时 Create 引导原子替换而不是先放弃', () => {
    const { controller } = activeController()
    controller.beginStep()

    const result = controller.create('另一个复杂任务', drafts)

    assert.equal(result.ok, false)
    assert.equal(result.ok ? null : result.error, 'active_plan_exists')
    assert.match(result.ok ? '' : result.message, /ReplaceTaskPlan/)
    assert.match(
      result.ok ? '' : result.message,
      /禁止用 CloseTaskPlan\(abandoned\)\+CreateTaskPlan/,
    )
    assert.deepEqual(controller.snapshot?.goal, '交付功能')
  })
})

function createController() {
  return {
    controller: new TaskPlanController(),
  }
}

function activeController() {
  const created = createController()
  created.controller.beginStep()
  created.controller.create('交付功能', drafts)
  created.controller.commitStep()
  return created
}
