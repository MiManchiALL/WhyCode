import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CoreEvent } from '@whycode/core/events'
import type { RuntimeEventEnvelope } from '../shared/session.ts'
import {
  RUNTIME_EVENT_BATCH_DELAY_MS,
  RuntimeEventBatcher,
} from './runtime-event-batcher.ts'

function envelope(
  sequence: number,
  event: CoreEvent,
  runtimeId = 'runtime-a',
  sessionId: string | null = 'session-a',
): RuntimeEventEnvelope {
  return {
    runtimeId,
    sessionId,
    sequence,
    occurredAt: `2026-08-30T00:00:00.${String(sequence).padStart(3, '0')}Z`,
    event,
  }
}

function createScheduledHarness() {
  const scheduled: { callback: () => void; cancelled: boolean }[] = []
  return {
    scheduled,
    schedule(callback: () => void, delayMs: number): () => void {
      assert.equal(delayMs, RUNTIME_EVENT_BATCH_DELAY_MS)
      const task = { callback, cancelled: false }
      scheduled.push(task)
      return () => { task.cancelled = true }
    },
    run(index: number): void {
      const task = scheduled[index]
      assert.ok(task)
      if (!task.cancelled) task.callback()
    },
  }
}

describe('RuntimeEventBatcher', () => {
  it('短窗口内合并相邻思考增量，并保留最新序号与时间', () => {
    const published: (readonly RuntimeEventEnvelope[])[] = []
    const scheduler = createScheduledHarness()
    const batcher = new RuntimeEventBatcher({
      publish: (events) => published.push(events),
      schedule: scheduler.schedule,
    })

    batcher.push(envelope(1, { type: 'thinking-delta', text: '深' }))
    batcher.push(envelope(2, { type: 'thinking-delta', text: '度' }))
    batcher.push(envelope(3, { type: 'thinking-delta', text: '思考' }))

    assert.equal(published.length, 0)
    assert.equal(scheduler.scheduled.length, 1)
    scheduler.run(0)
    assert.equal(published.length, 1)
    assert.deepEqual(published[0], [envelope(3, {
      type: 'thinking-delta',
      text: '深度思考',
    })])
  })

  it('结构事件立即排空此前流式事件并保持全局顺序', () => {
    const published: (readonly RuntimeEventEnvelope[])[] = []
    const scheduler = createScheduledHarness()
    const batcher = new RuntimeEventBatcher({
      publish: (events) => published.push(events),
      schedule: scheduler.schedule,
    })

    batcher.push(envelope(1, { type: 'thinking-delta', text: '思考中' }))
    batcher.push(envelope(2, { type: 'thinking-end', durationMs: 250 }))

    assert.deepEqual(published, [[
      envelope(1, { type: 'thinking-delta', text: '思考中' }),
      envelope(2, { type: 'thinking-end', durationMs: 250 }),
    ]])
    assert.equal(scheduler.scheduled[0]?.cancelled, true)
    scheduler.run(0)
    assert.equal(published.length, 1)
  })

  it('不同运行时或会话的增量不会跨路由合并', () => {
    const published: (readonly RuntimeEventEnvelope[])[] = []
    const scheduler = createScheduledHarness()
    const batcher = new RuntimeEventBatcher({
      publish: (events) => published.push(events),
      schedule: scheduler.schedule,
    })

    batcher.push(envelope(1, { type: 'text-delta', text: 'A' }))
    batcher.push(envelope(2, { type: 'text-delta', text: 'B' }, 'runtime-b', 'session-b'))
    batcher.push(envelope(3, { type: 'text-delta', text: 'C' }, 'runtime-a', 'session-c'))
    scheduler.run(0)

    assert.deepEqual(published, [[
      envelope(1, { type: 'text-delta', text: 'A' }),
      envelope(2, { type: 'text-delta', text: 'B' }, 'runtime-b', 'session-b'),
      envelope(3, { type: 'text-delta', text: 'C' }, 'runtime-a', 'session-c'),
    ]])
  })

  it('按原始输入上限排空同步洪峰，合并后仍不漏内容', () => {
    const published: (readonly RuntimeEventEnvelope[])[] = []
    const scheduler = createScheduledHarness()
    const batcher = new RuntimeEventBatcher({
      publish: (events) => published.push(events),
      schedule: scheduler.schedule,
      maxPendingInputs: 128,
    })

    for (let sequence = 1; sequence <= 10_000; sequence++) {
      batcher.push(envelope(sequence, { type: 'thinking-delta', text: 'x' }))
    }
    batcher.flush()

    assert.equal(
      published.flatMap((batch) => batch).reduce((length, item) => {
        assert.equal(item.event.type, 'thinking-delta')
        return length + item.event.text.length
      }, 0),
      10_000,
    )
    assert.ok(published.every((batch) => batch.length === 1))
    assert.equal(published.length, Math.ceil(10_000 / 128))
    for (let index = 0; index < scheduler.scheduled.length; index++) scheduler.run(index)
    assert.equal(
      published.flatMap((batch) => batch).reduce((length, item) => {
        assert.equal(item.event.type, 'thinking-delta')
        return length + item.event.text.length
      }, 0),
      10_000,
    )
  })

  it('手动快照排空后，旧定时回调不会重复发布', () => {
    const published: (readonly RuntimeEventEnvelope[])[] = []
    const scheduler = createScheduledHarness()
    const batcher = new RuntimeEventBatcher({
      publish: (events) => published.push(events),
      schedule: scheduler.schedule,
    })

    batcher.push(envelope(1, { type: 'text-delta', text: '快照前' }))
    batcher.flush()
    batcher.push(envelope(2, { type: 'text-delta', text: '快照后' }))
    scheduler.run(0)
    scheduler.run(1)

    assert.deepEqual(published, [
      [envelope(1, { type: 'text-delta', text: '快照前' })],
      [envelope(2, { type: 'text-delta', text: '快照后' })],
    ])
  })
})
