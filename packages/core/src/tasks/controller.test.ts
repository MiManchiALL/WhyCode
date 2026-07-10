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
    assert.equal(controller.commitStep()?.displayPlan.items.at(-1)?.kind, 'verification')
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

  it('未提交的 step 被丢弃时恢复原计划', () => {
    const { controller } = activeController()
    const before = controller.snapshot
    controller.beginStep()
    controller.updateItem('T1', 'blocked', [], '等待用户提供环境')
    controller.discardStep()

    assert.deepEqual(controller.snapshot, before)
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
})

function createController(initial: ConstructorParameters<typeof TaskPlanController>[0] = null) {
  return {
    controller: new TaskPlanController(initial),
  }
}

function activeController() {
  const created = createController()
  created.controller.beginStep()
  created.controller.create('交付功能', drafts)
  created.controller.commitStep()
  return created
}
