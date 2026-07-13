import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pushCoalescedViewEvent, toViewEvent, viewEventSchema, type ViewEvent } from './view-events.ts'

describe('用户可见事件契约', () => {
  it('只接收可恢复内容，排除审批和运行状态，并保留持久化检查点', () => {
    assert.equal(toViewEvent({ type: 'agent-status', status: 'working' }), null)
    assert.equal(
      toViewEvent({
        type: 'user-message-accepted',
        text: '仅用于当前窗口即时显示',
        startsTurn: true,
      }),
      null,
    )
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
    assert.deepEqual(
      toViewEvent({
        type: 'checkpoint-created',
        toolUseId: 'tool-1',
        hash: 'abc',
        coverage: 'complete',
      }),
      {
        type: 'core-event',
        event: {
          type: 'checkpoint-created',
          toolUseId: 'tool-1',
          hash: 'abc',
          coverage: 'complete',
        },
      },
    )
    assert.deepEqual(
      toViewEvent({ type: 'message-injected', id: 'queue-1', text: '补充要求' }),
      { type: 'user-message', text: '补充要求', startsTurn: false },
    )
    assert.deepEqual(
      toViewEvent({ type: 'consensus-skipped', reason: 'image-input' }),
      { type: 'core-event', event: { type: 'consensus-skipped', reason: 'image-input' } },
    )
    assert.deepEqual(
      toViewEvent({
        type: 'message-injected',
        id: 'queue-2',
        text: '下一项任务',
        startsTurn: true,
      }),
      { type: 'user-message', text: '下一项任务', startsTurn: true },
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

  it('图片元数据可持久化，但不允许把图片字节混入可见事件', () => {
    const event = {
      type: 'user-message',
      text: '分析图片',
      startsTurn: true,
      attachments: [{
        id: '22222222-2222-4222-8222-222222222222',
        sessionId: '11111111-1111-4111-8111-111111111111',
        name: 'screen.png',
        storageName: '22222222-2222-4222-8222-222222222222.png',
        mediaType: 'image/png',
        byteLength: 68,
        width: 1,
        height: 1,
      }],
    }
    assert.equal(viewEventSchema.safeParse(event).success, true)
    const parsed = viewEventSchema.parse({
      ...event,
      attachments: [{ ...event.attachments[0], base64: 'x' }],
    })
    assert.doesNotMatch(JSON.stringify(parsed), /base64/)
    assert.equal(viewEventSchema.safeParse({ ...event, startsTurn: false }).success, false)
  })
})

function core(event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent {
  return { type: 'core-event', event }
}
