import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TaskPlanController } from './controller.ts'
import { emptyTaskPlanState, taskItemSchema, taskPlanStateSchema } from './types.ts'

const drafts = [
  { kind: 'work' as const, outcome: '核心能力已经可用' },
  { kind: 'work' as const, outcome: '相关调用方已经统一' },
  { kind: 'verification' as const, outcome: '整体行为通过验证' },
]

describe('Main 长任务计划控制器', () => {
  it('严格拒绝旧版历史计划字段，不保留兼容结构', () => {
    const legacyState = { ...emptyTaskPlanState(), historicalPlans: [] }

    assert.equal(taskPlanStateSchema.safeParse(legacyState).success, false)
    assert.equal(taskItemSchema.safeParse({
      id: 'T1',
      kind: 'work',
      outcome: '旧阻塞项',
      status: 'blocked',
      evidence: [],
      blockedReason: '旧原因',
    }).success, false)
  })

  it('只接受 3～7 个宏观里程碑，创建后显式启动第一项', () => {
    const controller = new TaskPlanController()
    controller.beginStep()

    assert.equal(controller.create('交付功能', drafts).ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'pending',
      'pending',
      'pending',
    ])
    const commit = controller.commitStep()
    assert.equal(commit?.plan.items.at(-1)?.kind, 'verification')
    assert.equal(commit?.plan.items[0]?.outcome, '核心能力已经可用')

    controller.beginStep()
    assert.equal(controller.update([], { itemId: 'T1', status: 'in_progress' }).ok, true)
    assert.equal(controller.snapshot?.items[0]?.status, 'in_progress')
    controller.commitStep()

    const invalid = new TaskPlanController()
    invalid.beginStep()
    const result = invalid.create('无效计划', drafts.slice(0, 2))
    assert.equal(result.ok, false)
    assert.equal(result.ok ? null : result.error, 'invalid_plan')
  })

  it('用一次原子更新修订路线并完成当前里程碑', () => {
    const controller = activeController()
    controller.beginStep()

    const result = controller.update(
      [
        { action: 'edit', itemId: 'T2', outcome: '所有调用方使用统一协议' },
        { action: 'add', outcome: '迁移后的数据流已经收口', afterItemId: 'T2' },
      ],
      { itemId: 'T1', status: 'completed', evidence: ['核心测试通过'] },
    )

    assert.equal(result.ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => [item.id, item.status]), [
      ['T1', 'completed'],
      ['T2', 'pending'],
      ['T4', 'pending'],
      ['T3', 'pending'],
    ])
    assert.equal(controller.commitStep()?.state.version, 3)
  })

  it('结构变化全部校验通过后才提交', () => {
    const controller = activeController()
    const before = controller.stateSnapshot
    controller.beginStep()

    const result = controller.update([
      { action: 'edit', itemId: 'T2', outcome: '这项不应泄漏' },
      { action: 'delete', itemId: 'T3' },
    ])

    assert.equal(result.ok, false)
    assert.equal(result.ok ? null : result.error, 'invalid_plan')
    assert.deepEqual(controller.stateSnapshot, before)
    assert.equal(controller.commitStep(), undefined)
  })

  it('已完成项不可修改，删除待办项不会隐式推进其它项', () => {
    const controller = activeController()
    controller.beginStep()
    assert.equal(controller.update([], {
      itemId: 'T1',
      status: 'completed',
      evidence: ['实现证据'],
    }).ok, true)
    controller.commitStep()

    controller.beginStep()
    const immutable = controller.update([
      { action: 'edit', itemId: 'T1', outcome: '试图改写已确认结果' },
    ])
    assert.equal(immutable.ok, false)
    assert.equal(immutable.ok ? null : immutable.error, 'invalid_transition')
    controller.discardStep()

    controller.beginStep()
    assert.equal(controller.update([{ action: 'delete', itemId: 'T2' }]).ok, true)
    assert.equal(controller.snapshot?.items.find((item) => item.id === 'T3')?.status, 'pending')
  })

  it('完成要求先进入 in_progress，完成后不会隐式推进下一项', () => {
    const controller = activeController()
    controller.beginStep()

    const premature = controller.update([], {
      itemId: 'T2',
      status: 'completed',
      evidence: ['无效证据'],
    })
    assert.equal(premature.ok, false)
    assert.equal(premature.ok ? null : premature.error, 'invalid_transition')

    assert.equal(controller.update([], {
      itemId: 'T1',
      status: 'completed',
      evidence: ['实现已验证'],
    }).ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'completed',
      'pending',
      'pending',
    ])

    controller.commitStep()
    controller.beginStep()
    assert.equal(controller.update([], { itemId: 'T2', status: 'in_progress' }).ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'completed',
      'in_progress',
      'pending',
    ])
  })

  it('状态设置幂等且不产生空提交，真实结构变化仍会提交', () => {
    const controller = activeController()
    controller.beginStep()

    const changed = controller.update(
      [{ action: 'add', outcome: '新增路线已经完成' }],
      { itemId: 'T1', status: 'in_progress' },
    )
    assert.equal(changed.ok, true)
    assert.ok(controller.snapshot?.items.some((item) => item.outcome === '新增路线已经完成'))
    controller.commitStep()

    controller.beginStep()
    const before = controller.stateSnapshot
    const duplicate = controller.update([], { itemId: 'T1', status: 'in_progress' })
    assert.equal(duplicate.ok, true)
    assert.deepEqual(controller.stateSnapshot, before)
    assert.equal(controller.commitStep(), undefined)

    controller.beginStep()
    const unchangedStructure = controller.update([
      { action: 'edit', itemId: 'T2', outcome: '相关调用方已经统一' },
    ])
    assert.equal(unchangedStructure.ok, false)
    assert.equal(unchangedStructure.ok ? null : unchangedStructure.error, 'no_state_change')
    assert.equal(controller.commitStep(), undefined)
  })

  it('已完成状态只接受相同证据的幂等重放', () => {
    const controller = activeController()
    controller.beginStep()
    assert.equal(controller.update([], {
      itemId: 'T1',
      status: 'completed',
      evidence: ['实现已验证'],
    }).ok, true)
    controller.commitStep()

    controller.beginStep()
    const before = controller.stateSnapshot
    assert.equal(controller.update([], {
      itemId: 'T1',
      status: 'completed',
      evidence: ['实现已验证'],
    }).ok, true)
    assert.deepEqual(controller.stateSnapshot, before)
    assert.equal(controller.commitStep(), undefined)

    controller.beginStep()
    const rewrite = controller.update([], {
      itemId: 'T1',
      status: 'completed',
      evidence: ['试图改写证据'],
    })
    assert.equal(rewrite.ok, false)
    assert.equal(rewrite.ok ? null : rewrite.error, 'invalid_transition')
  })

  it('未提交的模型步骤会恢复完整计划', () => {
    const controller = activeController()
    const before = controller.snapshot
    controller.beginStep()
    controller.update([{ action: 'add', outcome: '临时路线' }])
    controller.discardStep()

    assert.deepEqual(controller.snapshot, before)
  })

  it('自然结束按完成度确定终态，终态不保存总结', () => {
    const incomplete = activeController()
    incomplete.beginStep()
    assert.equal(incomplete.finishNaturalRun().ok, true)
    assert.equal(incomplete.commitStep()?.plan.status, 'ended')
    assert.equal(incomplete.snapshot, null)

    const controller = activeController()
    completeCurrent(controller, 'T1')
    completeCurrent(controller, 'T2')
    completeCurrent(controller, 'T3')
    controller.beginStep()
    assert.equal(controller.finishNaturalRun().ok, true)
    const commit = controller.commitStep()

    assert.equal(controller.snapshot, null)
    assert.equal(commit?.plan.status, 'completed')
    assert.equal('summary' in (commit?.plan ?? {}), false)
  })

  it('硬中断后必须 Resume，恢复不会重写计划内容', () => {
    const controller = activeController()
    const planId = controller.snapshot!.id
    assert.equal(controller.interrupt('user-cancel')?.resumeRequired, true)

    controller.beginStep()
    const rejected = controller.update([], { itemId: 'T1', status: 'in_progress' })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.ok ? null : rejected.error, 'resume_required')
    assert.equal(controller.resume(planId).ok, true)
    const commit = controller.commitStep()
    assert.equal(commit?.state.resumeRequired, false)
    assert.equal(commit?.state.interruptionReason, null)
  })

  it('结束旧计划与创建新计划必须跨稳定步骤', () => {
    const controller = activeController()
    controller.beginStep()
    assert.equal(controller.close().ok, true)
    const sameStep = controller.create('新目标', drafts)
    assert.equal(sameStep.ok, false)
    assert.equal(sameStep.ok ? null : sameStep.error, 'step_conflict')
    controller.commitStep()

    controller.beginStep()
    assert.equal(controller.create('新目标', drafts).ok, true)
    assert.equal(controller.snapshot?.goal, '新目标')
  })

  it('已有活动计划时 Create 明确要求先处理当前计划', () => {
    const controller = activeController()
    controller.beginStep()
    const result = controller.create('另一个复杂任务', drafts)

    assert.equal(result.ok, false)
    assert.equal(result.ok ? null : result.error, 'active_plan_exists')
    assert.match(result.ok ? '' : result.message, /CloseTaskPlan/)
  })
})

function activeController(): TaskPlanController {
  const controller = new TaskPlanController()
  controller.beginStep()
  controller.create('交付功能', drafts)
  controller.commitStep()
  controller.beginStep()
  controller.update([], { itemId: 'T1', status: 'in_progress' })
  controller.commitStep()
  return controller
}

function completeCurrent(controller: TaskPlanController, itemId: string): void {
  startItem(controller, itemId)
  controller.beginStep()
  assert.equal(controller.update([], {
    itemId,
    status: 'completed',
    evidence: [`${itemId} 验证通过`],
  }).ok, true)
  controller.commitStep()
}

function startItem(controller: TaskPlanController, itemId: string): void {
  if (controller.snapshot?.items.find((item) => item.id === itemId)?.status === 'in_progress') return
  controller.beginStep()
  assert.equal(controller.update([], { itemId, status: 'in_progress' }).ok, true)
  controller.commitStep()
}
