import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pushCoalescedViewEvent, toViewEvent, viewEventSchema, type ViewEvent } from './view-events.ts'

describe('用户可见事件契约', () => {
  it('只接收可恢复内容，排除审批、运行状态和失效检查点', () => {
    assert.equal(toViewEvent({ type: 'agent-status', status: 'working' }), null)
    assert.equal(
      toViewEvent({
        type: 'approval-request',
        requestId: 'approval-1',
        toolName: 'WriteFile',
        input: {},
        reason: '需要确认',
      }),
      null,
    )
    assert.equal(
      toViewEvent({ type: 'checkpoint-created', toolUseId: 'tool-1', hash: 'abc' }),
      null,
    )
    assert.deepEqual(
      toViewEvent({ type: 'message-injected', id: 'queue-1', text: '补充要求' }),
      { type: 'user-message', text: '补充要求', startsTurn: false },
    )
  })

  it('合并连续文本但保持工具边界', () => {
    const events: ViewEvent[] = []
    pushCoalescedViewEvent(events, core({ type: 'text-delta', text: '前半' }))
    pushCoalescedViewEvent(events, core({ type: 'text-delta', text: '后半' }))
    pushCoalescedViewEvent(
      events,
      core({ type: 'tool-start', toolUseId: 'tool-1', toolName: 'ReadFile', input: {} }),
    )

    assert.equal(events.length, 2)
    assert.deepEqual(events[0], core({ type: 'text-delta', text: '前半后半' }))
  })

  it('拒绝结构不完整的持久化事件', () => {
    assert.equal(
      viewEventSchema.safeParse({ type: 'core-event', event: { type: 'tool-end' } }).success,
      false,
    )
  })
})

function core(event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent {
  return { type: 'core-event', event }
}
