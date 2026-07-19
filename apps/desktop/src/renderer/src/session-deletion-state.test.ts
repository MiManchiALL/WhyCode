import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCurrentSessionDeletion } from './session-deletion-state.ts'

describe('会话删除界面作用域', () => {
  it('以 Main 当前会话 ID 判定历史删除，不依赖异步历史列表', () => {
    assert.equal(isCurrentSessionDeletion('current', 'historical'), false)
  })

  it('删除当前会话立即锁定当前运行时', () => {
    assert.equal(isCurrentSessionDeletion('current', 'current'), true)
  })
})
