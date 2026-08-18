import assert from 'node:assert/strict'
import test from 'node:test'
import type { CoreEvent } from '@whycode/core/events'
import {
  ConversationEventBuffer,
  type BufferedConversationEvent,
} from './conversation-event-buffer.ts'
import { applyCoreEvent, createConversationState } from './conversation-state.ts'

function setupBuffer() {
  const batches: BufferedConversationEvent[][] = []
  const scheduled = new Map<number, () => void>()
  const cancelled: number[] = []
  let nextFrameId = 1
  const buffer = new ConversationEventBuffer({
    flush: (events) => batches.push([...events]),
    requestFrame: (callback) => {
      const id = nextFrameId++
      scheduled.set(id, callback)
      return id
    },
    cancelFrame: (id) => {
      cancelled.push(id)
      scheduled.delete(id)
    },
  })
  return {
    batches,
    buffer,
    cancelled,
    runFrame: () => {
      const entry = scheduled.entries().next()
      assert.ok(!entry.done)
      const [id, callback] = entry.value
      scheduled.delete(id)
      callback()
    },
    scheduled,
  }
}

test('同一帧只提交一次相邻流式正文并保留最新有效时间', () => {
  const { batches, buffer, runFrame, scheduled } = setupBuffer()
  buffer.push({ type: 'text-delta', text: '前半' }, '2026-08-19T10:00:00.000Z')
  buffer.push({ type: 'text-delta', text: '后半' }, '2026-08-19T10:00:00.010Z')

  assert.equal(batches.length, 0)
  assert.equal(scheduled.size, 1)
  runFrame()
  assert.deepEqual(batches, [[{
    event: { type: 'text-delta', text: '前半后半' },
    occurredAt: '2026-08-19T10:00:00.010Z',
  }]])
})

test('高频 token 流保持单帧、单事件提交', () => {
  const { batches, buffer, runFrame, scheduled } = setupBuffer()
  for (let index = 0; index < 1_000; index++) {
    buffer.push({ type: 'text-delta', text: '字' })
  }

  assert.equal(scheduled.size, 1)
  runFrame()
  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.length, 1)
  const event = batches[0]?.[0]?.event
  assert.ok(event?.type === 'text-delta')
  assert.equal(event.text.length, 1_000)
})

test('语义边界立即提交此前片段并保持严格顺序', () => {
  const { batches, buffer, cancelled, scheduled } = setupBuffer()
  buffer.push({ type: 'thinking-delta', text: '分析中' })
  buffer.push({ type: 'thinking-end', durationMs: 500 })

  assert.equal(scheduled.size, 0)
  assert.deepEqual(cancelled, [1])
  assert.deepEqual(
    batches[0]?.map(({ event }) => event),
    [
      { type: 'thinking-delta', text: '分析中' },
      { type: 'thinking-end', durationMs: 500 },
    ],
  )
})

test('动画帧暂停时仍以硬上限释放非相邻事件', () => {
  const { batches, buffer, cancelled, scheduled } = setupBuffer()
  for (let index = 0; index < 128; index++) {
    buffer.push(index % 2 === 0
      ? { type: 'text-delta', text: '正文' }
      : { type: 'thinking-delta', text: '推理' })
  }

  assert.equal(scheduled.size, 0)
  assert.deepEqual(cancelled, [1])
  assert.equal(batches.length, 1)
  assert.equal(batches[0]?.length, 128)
})

test('工具进度只合并同一工具，协商正文只合并同一 Agent', () => {
  const { batches, buffer, runFrame } = setupBuffer()
  const events: CoreEvent[] = [
    { type: 'tool-progress', toolUseId: 'tool-1', output: 'a' },
    { type: 'tool-progress', toolUseId: 'tool-1', output: 'b' },
    { type: 'tool-progress', toolUseId: 'tool-2', output: 'c' },
    { type: 'peer-event', agentId: 'B', event: { type: 'text-delta', text: '甲' } },
    { type: 'peer-event', agentId: 'B', event: { type: 'text-delta', text: '乙' } },
    { type: 'peer-event', agentId: 'C', event: { type: 'text-delta', text: '丙' } },
  ]
  for (const event of events) buffer.push(event)
  runFrame()

  assert.deepEqual(
    batches[0]?.map(({ event }) => event),
    [
      { type: 'tool-progress', toolUseId: 'tool-1', output: 'ab' },
      { type: 'tool-progress', toolUseId: 'tool-2', output: 'c' },
      { type: 'peer-event', agentId: 'B', event: { type: 'text-delta', text: '甲乙' } },
      { type: 'peer-event', agentId: 'C', event: { type: 'text-delta', text: '丙' } },
    ],
  )
})

test('清空会取消未提交帧，供快照切换丢弃旧 Runtime 事件', () => {
  const { batches, buffer, cancelled, scheduled } = setupBuffer()
  buffer.push({ type: 'text-delta', text: '旧会话片段' })
  buffer.clear()

  assert.equal(scheduled.size, 0)
  assert.deepEqual(cancelled, [1])
  assert.deepEqual(batches, [])
})

test('分帧提交与逐事件投影在工具和步骤边界上语义一致', () => {
  const { batches, buffer } = setupBuffer()
  const entries: BufferedConversationEvent[] = [
    { event: { type: 'thinking-delta', text: '读取' } },
    { event: { type: 'thinking-delta', text: '源码' } },
    { event: { type: 'thinking-end', durationMs: 500 } },
    { event: { type: 'text-delta', text: '阶段' }, occurredAt: '2026-08-19T10:00:00.000Z' },
    { event: { type: 'text-delta', text: '结论' }, occurredAt: '2026-08-19T10:00:00.010Z' },
    { event: { type: 'tool-start', toolUseId: 'read-1', toolName: 'ReadFile', input: {} } },
    { event: { type: 'tool-progress', toolUseId: 'read-1', output: '前半' } },
    { event: { type: 'tool-progress', toolUseId: 'read-1', output: '后半' } },
    { event: { type: 'tool-end', toolUseId: 'read-1', result: '完成', isError: false } },
    { event: { type: 'step-committed' } },
  ]
  for (const { event, occurredAt } of entries) buffer.push(event, occurredAt)

  const sequential = entries.reduce(
    (state, { event, occurredAt }) => applyCoreEvent(state, event, occurredAt),
    createConversationState(),
  )
  const buffered = batches.flat().reduce(
    (state, { event, occurredAt }) => applyCoreEvent(state, event, occurredAt),
    createConversationState(),
  )
  assert.deepEqual(buffered, sequential)
})

test('停止时保留正文并丢弃工具过程的事务语义不变', () => {
  const { batches, buffer } = setupBuffer()
  const entries: BufferedConversationEvent[] = [
    { event: { type: 'text-delta', text: '已经输出' } },
    { event: { type: 'text-delta', text: '的正文' } },
    { event: { type: 'tool-start', toolUseId: 'tool-1', toolName: 'ReadFile', input: {} } },
    { event: { type: 'tool-progress', toolUseId: 'tool-1', output: '未提交过程' } },
    { event: { type: 'step-output-retained' } },
    { event: { type: 'step-discarded' } },
  ]
  for (const { event, occurredAt } of entries) buffer.push(event, occurredAt)

  const project = (eventBatches: readonly (readonly BufferedConversationEvent[])[]) =>
    eventBatches.flat().reduce(
      (state, { event, occurredAt }) => applyCoreEvent(state, event, occurredAt),
      createConversationState(),
    )
  const sequential = project(entries.map((entry) => [entry]))
  const buffered = project(batches)

  assert.deepEqual(buffered, sequential)
  assert.deepEqual(buffered.blocks.map((block) => block.kind), ['text'])
})
