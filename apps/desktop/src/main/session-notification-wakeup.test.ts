import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SessionNotificationWakeQueue } from './session-notification-wakeup.ts'

describe('会话内部通知队列', () => {
  it('父会话已删除时丢弃通知并执行持久化收尾', async () => {
    const dropped: string[] = []
    const queue = new SessionNotificationWakeQueue<{ id: string; sessionId: string }>({
      key: (notification) => notification.id,
      sessionId: (notification) => notification.sessionId,
      resolveRuntime: async () => ({ kind: 'drop' }),
      reserveWorkStart: () => null,
      deliveryBlocked: () => false,
      deliver: () => assert.fail('已删除会话不能收到内部通知'),
      onDrop: (notification) => { dropped.push(notification.id) },
    })

    queue.enqueue({ id: 'settlement-1', sessionId: 'parent-1' })
    await queue.nudge()
    await queue.nudge()
    assert.deepEqual(dropped, ['settlement-1'])
    await queue.close()
  })
})
