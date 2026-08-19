import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { localWorkspace, type SessionSummary } from '@whycode/core'
import { projectSessionListItems } from './session-list.ts'

describe('projectSessionListItems', () => {
  it('置顶项保留手动顺序，最近项保留事实源时间顺序', () => {
    const summaries = [summary('newest', 3), summary('middle', 2), summary('oldest', 1)]
    const items = projectSessionListItems(
      summaries,
      [],
      null,
      ['oldest', 'newest'],
      () => false,
    )

    assert.deepEqual(items.map((item) => item.sessionId), ['oldest', 'newest', 'middle'])
    assert.deepEqual(items.map((item) => item.pinned), [true, true, false])
  })

  it('从已加载运行时和完成通知投影动态标记', () => {
    const items = projectSessionListItems(
      [summary('running', 2), summary('finished', 1)],
      [{ sessionId: 'running', busy: true }],
      'running',
      [],
      (sessionId) => sessionId === 'finished',
    )

    assert.deepEqual(items.map(({ sessionId, isCurrent, running, hasUnreadCompletion }) => ({
      sessionId,
      isCurrent,
      running,
      hasUnreadCompletion,
    })), [
      { sessionId: 'running', isCurrent: true, running: true, hasUnreadCompletion: false },
      { sessionId: 'finished', isCurrent: false, running: false, hasUnreadCompletion: true },
    ])
  })
})

function summary(sessionId: string, order: number): SessionSummary {
  return {
    sessionId,
    title: sessionId,
    lastUserText: sessionId,
    createdAt: new Date(order).toISOString(),
    updatedAt: new Date(order).toISOString(),
    resumable: true,
    workspace: localWorkspace(process.cwd()),
    modelId: 'deepseek:deepseek-v4-flash',
    reasoningEffort: 'default',
    status: 'idle',
  }
}
