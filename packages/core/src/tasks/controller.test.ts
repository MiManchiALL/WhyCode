import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TaskPlanController } from './controller.ts'
import { taskItemSchema, taskPlanStateSchema } from './types.ts'

const drafts = [
  { kind: 'work' as const, outcome: '核心能力已经可用' },
  { kind: 'work' as const, outcome: '相关调用方已经统一' },
  { kind: 'verification' as const, outcome: '整体行为通过验证' },
]

describe('Main 长任务计划控制器', () => {
  it('任务状态只投影当前版本和活动计划，并校验里程碑', () => {
    const state = activeController().stateSnapshot
    assert.deepEqual(Object.keys(state).sort(), ['activePlan', 'version'])
    assert.equal(taskPlanStateSchema.safeParse({ ...state, version: -1 }).success, false)
    assert.equal(taskItemSchema.safeParse({
      id: 'T1',
      kind: 'work',
      outcome: '旧阻塞项',
      status: 'blocked',
      evidence: [],
      blockedReason: '旧原因',
    }).success, false)
  })

  it('只接受 3～7 个宏观里程碑，创建时启动第一项并提交同一状态', () => {
    const controller = new TaskPlanController()
    controller.beginStep()

    const result = controller.create('交付功能', drafts)
    assert.equal(result.ok, true)
    assert.match(result.message, /T1.*核心能力已经可用/)
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'in_progress',
      'pending',
      'pending',
    ])
    const commit = controller.commitStep()
    assert.deepEqual(commit?.plan, commit?.state.activePlan)
    assert.equal(commit?.state.version, 1)
    assert.equal(commit?.plan.items.at(-1)?.kind, 'verification')
    assert.equal(commit?.plan.items[0]?.outcome, '核心能力已经可用')
    const original = controller.stateSnapshot
    const snapshot = controller.snapshot!
    snapshot.items[0]!.evidence.push('外部修改')
    commit!.plan.items[0]!.outcome = '外部修改'
    commit!.state.activePlan!.items[0]!.outcome = '外部修改'
    assert.deepEqual(controller.stateSnapshot, original)
    const restored = new TaskPlanController(original)
    original.activePlan!.items[0]!.outcome = '外部修改'
    assert.equal(restored.snapshot?.items[0]?.outcome, '核心能力已经可用')

    const invalid = new TaskPlanController()
    invalid.beginStep()
    const rejected = invalid.create('无效计划', drafts.slice(0, 2))
    assert.equal(rejected.ok, false)
    assert.equal(rejected.ok ? null : rejected.error, 'invalid_plan')
  })

  it('用一次原子更新修订路线并完成当前里程碑', () => {
    const controller = activeController()
    controller.beginStep()

    const result = controller.update(
      [
        { action: 'edit', itemId: 'T2', outcome: '所有调用方使用统一协议' },
        { action: 'add', outcome: '迁移后的数据流已经收口', afterItemId: 'T2' },
        { action: 'edit', itemId: 'T4', afterItemId: 'T1' },
      ],
      { itemId: 'T1', status: 'completed', evidence: ['核心测试通过'] },
    )

    assert.equal(result.ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => [item.id, item.status]), [
      ['T1', 'completed'],
      ['T4', 'in_progress'],
      ['T2', 'pending'],
      ['T3', 'pending'],
    ])
    assert.match(result.message, /T1 已完成.*T4.*迁移后的数据流已经收口/)
    const commit = controller.commitStep()
    assert.equal(commit?.state.version, 2)
    assert.equal(commit?.plan.revision, 2)
    assert.deepEqual(commit?.plan, commit?.state.activePlan)
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

  it('已完成项不可修改，删除进行中项不会自动启动其它项', () => {
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
    assert.equal(controller.snapshot?.items.some((item) => item.status === 'in_progress'), false)
    assert.equal(controller.snapshot?.items.find((item) => item.id === 'T3')?.status, 'pending')
    controller.commitStep()

    controller.beginStep()
    assert.equal(controller.update([], { itemId: 'T3', status: 'in_progress' }).ok, true)
    assert.equal(controller.snapshot?.items.find((item) => item.id === 'T3')?.status, 'in_progress')
  })

  it('仅凭真实证据完成进行中项，随后自动启动下一项直至最终验证', () => {
    const controller = activeController()
    const before = controller.stateSnapshot
    controller.beginStep()

    const premature = controller.update([], {
      itemId: 'T2',
      status: 'completed',
      evidence: ['无效证据'],
    })
    assert.equal(premature.ok, false)
    assert.equal(premature.ok ? null : premature.error, 'invalid_transition')
    const missingEvidence = controller.update(
      [{ action: 'edit', itemId: 'T2', outcome: '这项不应泄漏' }],
      { itemId: 'T1', status: 'completed', evidence: ['  '] },
    )
    assert.equal(missingEvidence.ok, false)
    assert.equal(missingEvidence.ok ? null : missingEvidence.error, 'evidence_required')
    assert.deepEqual(controller.stateSnapshot, before)
    assert.equal(controller.commitStep(), undefined)

    controller.beginStep()
    assert.equal(controller.update([], {
      itemId: 'T1',
      status: 'completed',
      evidence: ['实现已验证'],
    }).ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'completed',
      'in_progress',
      'pending',
    ])

    controller.commitStep()
    completeCurrent(controller, 'T2')
    assert.deepEqual(controller.snapshot?.items.map((item) => item.status), [
      'completed',
      'completed',
      'in_progress',
    ])
    assert.deepEqual(controller.snapshot?.items[2]?.evidence, [])

    controller.beginStep()
    const verified = controller.update([], {
      itemId: 'T3', status: 'completed', evidence: ['整体测试通过'],
    })
    assert.equal(verified.ok, true)
    assert.match(verified.message, /全部里程碑已完成/)
    assert.ok(controller.snapshot?.items.every((item) => item.status === 'completed'))
    assert.equal(controller.snapshot?.status, 'active')
  })

  it('删除待办项保留当前进度，完成后跳过已删除项', () => {
    const controller = activeController()
    controller.beginStep()
    assert.equal(controller.update([{ action: 'delete', itemId: 'T2' }]).ok, true)
    assert.deepEqual(controller.snapshot?.items.map((item) => [item.id, item.status]), [
      ['T1', 'in_progress'], ['T3', 'pending'],
    ])
    controller.commitStep()
    completeCurrent(controller, 'T1')
    assert.deepEqual(controller.snapshot?.items.map((item) => [item.id, item.status]), [
      ['T1', 'completed'], ['T3', 'in_progress'],
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

  it('已完成状态只接受相同证据的幂等重放，不重复推进或创建提交', () => {
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
    assert.equal(before.activePlan?.items[1]?.status, 'in_progress')
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

  it('未提交的模型步骤撤销结构变更、当前项完成与下一项启动', () => {
    const controller = activeController()
    const before = controller.stateSnapshot
    controller.beginStep()
    assert.equal(controller.update(
      [{ action: 'add', outcome: '临时路线' }],
      { itemId: 'T1', status: 'completed', evidence: ['实现证据'] },
    ).ok, true)
    assert.equal(controller.snapshot?.items[1]?.status, 'in_progress')
    controller.discardStep()

    assert.deepEqual(controller.stateSnapshot, before)
  })

  it('自然收尾只结束已核验全部里程碑的计划', () => {
    const controller = activeController()
    const before = controller.stateSnapshot
    controller.beginStep()
    controller.finishIfComplete()
    assert.equal(controller.commitStep(), undefined)
    assert.deepEqual(controller.stateSnapshot, before)

    for (const id of ['T1', 'T2', 'T3']) completeCurrent(controller, id)
    controller.beginStep()
    controller.finishIfComplete()
    assert.equal(controller.commitStep()?.plan.status, 'completed')
    assert.equal(controller.snapshot, null)
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

  it('创建会原子替换活动计划，校验失败和步骤撤销保留旧计划', () => {
    const controller = activeController()
    const previous = controller.stateSnapshot
    controller.beginStep()
    const invalid = controller.create('新任务', drafts.slice(0, 2))
    assert.equal(invalid.ok ? null : invalid.error, 'invalid_plan')
    assert.equal(controller.commitStep(), undefined)
    assert.deepEqual(controller.stateSnapshot, previous)

    controller.beginStep()
    assert.ok(controller.create('新任务', drafts).ok)
    controller.discardStep()
    assert.deepEqual(controller.stateSnapshot, previous)

    controller.beginStep()
    const created = controller.create('新任务', drafts)
    const commit = controller.commitStep()!
    assert.ok(created.ok)
    assert.match(created.message, /^已建立 3 项宏观计划/)
    assert.doesNotMatch(created.message, /替换|覆盖|旧计划/)
    assert.equal(commit.plan.goal, '新任务')
    assert.notEqual(commit.plan.id, previous.activePlan!.id)
    assert.equal(commit.plan.revision, 1)
    assert.equal(commit.state.version, previous.version + 1)
  })
})

function activeController(): TaskPlanController {
  const controller = new TaskPlanController()
  controller.beginStep()
  controller.create('交付功能', drafts)
  controller.commitStep()
  return controller
}

function completeCurrent(controller: TaskPlanController, itemId: string): void {
  assert.equal(controller.snapshot?.items.find((item) => item.id === itemId)?.status, 'in_progress')
  controller.beginStep()
  assert.equal(controller.update([], {
    itemId,
    status: 'completed',
    evidence: [`${itemId} 验证通过`],
  }).ok, true)
  controller.commitStep()
}
