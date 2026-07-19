import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isCurrentSessionDeletion } from './session-deletion-state.ts'

const sessions = [
  { sessionId: 'current', isCurrent: true },
  { sessionId: 'historical', isCurrent: false },
]

describe('会话删除界面作用域', () => {
  it('删除历史会话不锁定当前运行时', () => {
    assert.equal(isCurrentSessionDeletion(sessions, 'historical'), false)
  })

  it('删除当前会话立即锁定当前运行时', () => {
    assert.equal(isCurrentSessionDeletion(sessions, 'current'), true)
  })
})
