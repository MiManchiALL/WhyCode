import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { canChangeSessionWorkspace } from './workspace-selection.ts'

describe('会话工作区选择边界', () => {
  it('尚未持久化的草稿可以选择或移除工作区', () => {
    assert.equal(canChangeSessionWorkspace(null), true)
  })

  it('持久会话即使回滚为空也保持原工作区绑定', () => {
    assert.equal(
      canChangeSessionWorkspace('11111111-1111-4111-8111-111111111111'),
      false,
    )
  })
})
