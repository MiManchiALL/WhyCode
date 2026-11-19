import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TaskPlanItemChange } from './tools.ts'
import { TaskPlanController } from './controller.ts'
import { taskPlanStateSchema } from './types.ts'

const drafts = [
  { kind: 'work' as const, outcome: '核心能力已经可用' },
  { kind: 'work' as const, outcome: '相关调用方已经统一' },
  { kind: 'verification' as const, outcome: '整体行为通过验证' },
]

describe('Main 长任务计划控制器', () => {
  it('任务状态只投影当前版本和活动计划', () => {
    const state = activeController().stateSnapshot
    assert.deepEqual(Object.keys(state).sort(), ['activePlan', 'version'])
    assert.equal(taskPlanStateSchema.safeParse({ ...state, version: -1 }).success, false)
  })

  it('创建时可同时启动多项，提交和恢复的快照彼此独立', () => {
    const controller = new TaskPlanController()

    const result = controller.create('交付功能', [
      { ...drafts[0]!, status: 'in_progress' }, { ...drafts[1]!, status: 'in_progress' }, drafts[2]!,
    ])
    assert.equal(result.ok, true)
    assert.equal(result.message, [
      '已建立计划「交付功能」，进度 0/3。',
      'T1 [in_progress] 核心能力已经可用',
      'T2 [in_progress] 相关调用方已经统一',
      'T3 [pending] 整体行为通过验证（整体验证）',
    ].join('\n'))
    const staged = controller.pendingUpdate!
    assert.deepEqual(staged.plan.items.map((item) => item.status), [
      'in_progress',
      'in_progress',
      'pending',
    ])
    const update = commit(controller)!
    assert.deepEqual(update.plan, update.state.activePlan)
    assert.equal(update.state.version, 1)
    assert.equal(update.plan.items.at(-1)?.kind, 'verification')
    assert.equal(update.plan.items[0]?.outcome, '核心能力已经可用')
    const original = controller.stateSnapshot
    const snapshot = controller.stateSnapshot.activePlan!
    snapshot.items[0]!.evidence.push('外部修改')
    update.plan.items[0]!.outcome = '外部修改'
    update.state.activePlan!.items[0]!.outcome = '外部修改'
    assert.deepEqual(controller.stateSnapshot, original)
    const restored = new TaskPlanController(original)
    original.activePlan!.items[0]!.outcome = '外部修改'
    assert.equal(restored.stateSnapshot.activePlan?.items[0]?.outcome, '核心能力已经可用')

    const invalid = new TaskPlanController()

    const rejected = invalid.create('无效计划', drafts.slice(0, 2))
    assert.equal(rejected.ok, false)
    assert.equal(rejected.ok ? null : rejected.error, 'invalid_plan')
  })

  it('创建时可全部待办，批量启动、修订和完成各项均以显式变更为准', () => {
    const controller = activeController()
    assert.deepEqual(controller.stateSnapshot.activePlan?.items.map(item => item.status), ['pending', 'pending', 'pending'])

    const started = controller.update([
      { action: 'edit', item_id: 'T1', status: 'in_progress' },
      { action: 'edit', item_id: 'T2', status: 'in_progress', outcome: '所有调用方使用统一协议' },
      { action: 'add', after_item_id: 'T2', outcome: '迁移路径已经验证', status: 'in_progress' },
    ])
    assert.ok(started.ok)
    assert.match(started.message, /在 T2 后新增 T3「迁移路径已经验证」（进行中）/)
    assert.deepEqual(commit(controller)?.plan.items.map(item => item.status), [
      'in_progress', 'in_progress', 'in_progress', 'pending',
    ])

    const revised = controller.update([
      { action: 'edit', item_id: 'T3', after_item_id: 'T1' },
      { action: 'edit', item_id: 'T1', status: 'completed', evidence: ['核心测试通过'] },
      { action: 'edit', item_id: 'T2', status: 'completed', evidence: ['调用方检查通过'] },
    ])
    assert.ok(revised.ok)
    const update = commit(controller)!
    assert.equal(update.state.version, 3)
    assert.equal(update.plan.revision, 3)
    assert.deepEqual(update.plan.items.map(item => [item.outcome, item.status]), [
      ['核心能力已经可用', 'completed'], ['迁移路径已经验证', 'in_progress'],
      ['所有调用方使用统一协议', 'completed'], ['整体行为通过验证', 'pending'],
    ])
    assert.match(revised.message, /原 T3 已移至 T2「迁移路径已经验证」/)

    assert.ok(controller.update([{ action: 'delete', item_id: 'T2' }]).ok)
    assert.deepEqual(commit(controller)?.plan.items.map(item => item.status), ['completed', 'completed', 'pending'])
  })

  it('插入和删除按提交后的顺序编号，同批编辑始终指向调用前的项', () => {
    const controller = activeController()
    const changed = controller.update([
      { action: 'add', outcome: '兼容旧配置', after_item_id: 'T1', status: 'in_progress' },
      { action: 'edit', item_id: 'T2', status: 'completed', evidence: ['调用方已通过集成测试'] },
    ])
    assert.equal(changed.message, [
      '已在 T1 后新增 T2「兼容旧配置」（进行中）。',
      '已完成 T3「相关调用方已经统一」，进度 1/4。进行中：T2「兼容旧配置」。',
    ].join('\n'))
    const saved = commit(controller)!.state
    assert.deepEqual(saved.activePlan!.items[2]!.evidence, ['调用方已通过集成测试'])
    const restored = new TaskPlanController(saved)
    const removed = restored.update([{ action: 'delete', item_id: 'T2' }])
    assert.match(removed.message, /已删除原 T2「兼容旧配置」，进度 1\/3/)
    commit(restored)
    assert.match(restored.update([{ action: 'delete', item_id: 'T2' }]).message, /T2 已完成/)
    assert.equal(restored.close().message, '计划已按要求结束，已完成 1/3。')
  })

  it('状态和结构在同一次提交中校验，失败时不泄漏部分修改', () => {
    const controller = activeController()
    const before = controller.stateSnapshot

    for (const change of [
      { action: 'delete', item_id: 'T3' },
      { action: 'edit', item_id: 'T2', status: 'completed' },
      { action: 'edit', item_id: 'T1', status: 'completed', evidence: [] },
      { action: 'edit', item_id: 'T2', after_item_id: 'T3' },
    ] satisfies TaskPlanItemChange[]) {
      const result = controller.update([
        { action: 'edit', item_id: 'T1', status: 'in_progress', outcome: '临时结果' },
        change,
      ])
      assert.equal(result.ok, false)
      assert.deepEqual(controller.stateSnapshot, before)
    }
    assert.equal(commit(controller), undefined)
  })

  it('重复设置状态不创建新修订，已完成的项目和证据保持只读', () => {
    const controller = activeController()

    const start = { action: 'edit', item_id: 'T1', status: 'in_progress' } as const
    const finish = { action: 'edit' as const, item_id: 'T1', status: 'completed' as const, evidence: ['核心测试通过'] }
    assert.ok(controller.update([start]).ok)
    commit(controller)

    assert.ok(controller.update([start]).ok)
    assert.equal(commit(controller), undefined)

    assert.ok(controller.update([finish]).ok)
    commit(controller)

    const before = controller.stateSnapshot
    assert.ok(controller.update([finish]).ok)
    assert.equal(controller.update([{ ...finish, evidence: ['改写证据'] }]).ok, false)
    assert.equal(controller.update([{ action: 'edit', item_id: 'T1', outcome: '改写结果' }]).ok, false)
    assert.equal(controller.update([{ action: 'delete', item_id: 'T1' }]).ok, false)
    assert.equal(controller.update([start]).ok, false)
    assert.equal(commit(controller), undefined)
    assert.deepEqual(controller.stateSnapshot, before)
  })

  it('提交最后一批证据即关闭计划，撤销该批时可恢复未完成状态', () => {
    const controller = activeController()
    const ids = ['T1', 'T2', 'T3']

    controller.update(ids.map(item_id => ({ action: 'edit', item_id, status: 'in_progress' })))
    commit(controller)
    const before = controller.stateSnapshot
    const finish = ids.map(item_id => ({
      action: 'edit' as const, item_id, status: 'completed' as const, evidence: [`${item_id} 验证通过`],
    }))

    assert.ok(controller.update(finish).ok)
    assert.equal(controller.pendingUpdate?.state.activePlan, null)
    assert.deepEqual(controller.stateSnapshot, before)
    controller.discardUpdate()
    assert.deepEqual(controller.stateSnapshot, before)

    const result = controller.update(finish)
    assert.ok(result.ok)
    const update = commit(controller)!
    assert.deepEqual(update.state, { version: before.version + 1, activePlan: null })
    assert.equal(update.plan.status, 'completed')
    assert.equal(update.plan.revision, before.activePlan!.revision + 1)
    assert.deepEqual(update.plan.items.map(item => item.evidence), finish.map(change => change.evidence))
    assert.deepEqual(controller.stateSnapshot, update.state)
  })

  it('关闭计划的变更提交后才能创建新计划', () => {
    const controller = activeController()

    assert.equal(controller.close().ok, true)
    const beforeCommit = controller.create('新目标', drafts)
    assert.equal(beforeCommit.ok, false)
    assert.equal(beforeCommit.ok ? null : beforeCommit.error, 'step_conflict')
    commit(controller)

    assert.equal(controller.create('新目标', drafts).ok, true)
    assert.equal(commit(controller)?.plan.goal, '新目标')
  })

  it('创建会原子替换活动计划，校验失败和步骤撤销保留旧计划', () => {
    const controller = activeController()
    const previous = controller.stateSnapshot

    const invalid = controller.create('新任务', drafts.slice(0, 2))
    assert.equal(invalid.ok ? null : invalid.error, 'invalid_plan')
    assert.equal(commit(controller), undefined)
    assert.deepEqual(controller.stateSnapshot, previous)

    assert.ok(controller.create('新任务', drafts).ok)
    controller.discardUpdate()
    assert.deepEqual(controller.stateSnapshot, previous)

    const created = controller.create('新任务', drafts)
    const update = commit(controller)!
    assert.ok(created.ok)
    assert.match(created.message, /^已建立计划「新任务」，进度 0\/3。/)
    assert.doesNotMatch(created.message, /替换|覆盖|旧计划/)
    assert.equal(update.plan.goal, '新任务')
    assert.notEqual(update.plan.id, previous.activePlan!.id)
    assert.equal(update.plan.revision, 1)
    assert.equal(update.state.version, previous.version + 1)
  })
})

function activeController(): TaskPlanController {
  const controller = new TaskPlanController()

  controller.create('交付功能', drafts)
  commit(controller)
  return controller
}

function commit(controller: TaskPlanController) {
  const update = controller.pendingUpdate
  controller.commitUpdate()
  return update
}
