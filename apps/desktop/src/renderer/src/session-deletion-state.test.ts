import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isCurrentSessionDeletion,
  updateDeletingSessions,
} from './session-deletion-state.ts'

describe('会话删除界面作用域', () => {
  it('以 Main 当前会话 ID 判定历史删除，不依赖异步历史列表', () => {
    assert.equal(isCurrentSessionDeletion('current', 'historical'), false)
  })

  it('删除当前会话立即锁定当前运行时', () => {
    assert.equal(isCurrentSessionDeletion('current', 'current'), true)
  })

  it('新增目标和导航快照保留其它删除，单个完成或失败不解除其它目标', () => {
    const first = updateDeletingSessions(new Set(), 'historical', true)
    const both = updateDeletingSessions(first, 'current', true)
    assert.deepEqual([...first], ['historical'])
    assert.deepEqual([...both], ['historical', 'current'])
    assert.equal(updateDeletingSessions(both, 'current', true), both)
    const remaining = updateDeletingSessions(both, 'current', false)
    assert.deepEqual([...remaining], ['historical'])
    assert.equal(updateDeletingSessions(remaining, 'current', false), remaining)
    assert.equal(updateDeletingSessions(remaining, 'historical', false).size, 0)
  })

  it('完成事件先于 IPC 确认时，重复解除保持结束状态', () => {
    const pending = updateDeletingSessions(new Set(), 'target', true)
    const completed = updateDeletingSessions(pending, 'target', false)
    assert.equal(updateDeletingSessions(completed, 'target', false), completed)
  })
})
