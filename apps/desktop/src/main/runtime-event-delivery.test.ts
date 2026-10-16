import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CoreEvent } from '@whycode/core/events'
import { shouldDeliverRuntimeEvent } from './runtime-event-delivery.ts'
import { SessionNavigation } from './session-navigation.ts'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { RuntimeSnapshot } from '../shared/session.ts'
import { applyCoreEvent, createConversationState } from '../shared/conversation-state.ts'

const hidden = { sessionId: 'background' }

describe('后台运行时事件投影', () => {
  it('保留会话列表需要的开始、结束与终态事件', () => {
    const lifecycleEvents: CoreEvent[] = [
      { type: 'work-started', startedAt: 1_000 },
      { type: 'turn-start', turnId: 'turn-1' },
      {
        type: 'turn-end',
        turnId: 'turn-1',
        stopReason: 'completed',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0 },
      },
      { type: 'work-finished', durationMs: 1_000, outcome: 'completed', forkTurnId: null },
      { type: 'agent-status', status: 'idle' },
      { type: 'agent-status', status: 'error' },
    ]

    for (const event of lifecycleEvents) {
      assert.equal(shouldDeliverRuntimeEvent(event, hidden, null, null), true)
    }
  })

  it('不投影不可见会话的流式正文、思考、工具和中间状态', () => {
    const hiddenEvents: CoreEvent[] = [
      { type: 'text-delta', text: '正文' },
      { type: 'thinking-delta', text: '思考' },
      { type: 'thinking-end', durationMs: 500 },
      { type: 'tool-progress', toolUseId: 'tool-1', output: '输出' },
      { type: 'agent-status', status: 'working' },
      { type: 'agent-status', status: 'waiting-approval' },
    ]

    for (const event of hiddenEvents) {
      assert.equal(shouldDeliverRuntimeEvent(event, hidden, null, null), false)
    }
  })

  it('恢复快照取得后、选择提交前的工具封口不丢失，最终正文仍能收起过程', async () => {
    const current = { sessionId: 'current' } as DesktopSessionRuntime
    const target = { runtimeId: 'target', sessionId: 'target' } as DesktopSessionRuntime
    let selected = current
    const stream: CoreEvent[] = []
    const initial = applyCoreEvent(createConversationState([{ type: 'user-message', text: '操作网页', startsTurn: true }]),
      { type: 'tool-start', toolName: 'Browser', toolUseId: 'browser', input: { code: 'await browser.snapshot()' } })
    const snapshot = { runtimeId: target.runtimeId, sessionId: target.sessionId } as RuntimeSnapshot
    let captured!: () => void
    const capturedSnapshot = new Promise<void>(resolve => { captured = resolve })
    let complete!: () => void
    const awaitingMetadata = new Promise<void>(resolve => { complete = resolve })
    const navigation = new SessionNavigation({
      find: () => target, prepare: async () => {},
      snapshot: async () => { captured(); await awaitingMetadata; return snapshot },
      commit: runtime => { selected = runtime }, settled: () => {},
    })
    const restoring = navigation.resume(target.sessionId!)
    await capturedSnapshot
    for (const event of [
      { type: 'tool-end', toolUseId: 'browser', result: '已完成', isError: false },
      { type: 'step-committed' },
    ] satisfies CoreEvent[]) {
      if (shouldDeliverRuntimeEvent(event, target, selected, navigation.sessionId)) stream.push(event)
    }
    complete()
    assert.equal((await restoring).ok, true)
    let restored = stream.reduce((state, event) => applyCoreEvent(state, event), initial)
    for (const event of [
      { type: 'text-delta', text: '浏览器操作已完成。' },
      { type: 'step-committed' },
      { type: 'work-finished', durationMs: 100, outcome: 'completed', forkTurnId: null },
    ] satisfies CoreEvent[]) restored = applyCoreEvent(restored, event)
    assert.ok(restored.blocks.some(block => block.kind === 'text' && block.phase === 'final' && block.text === '浏览器操作已完成。'))
    assert.equal(restored.expanded.has('work-b0'), false)
    assert.equal(restored.blocks.at(-1)?.kind, 'work-duration')
    assert.equal(shouldDeliverRuntimeEvent({ type: 'text-delta', text: '旧目标' }, target, current, 'another'), false)
  })
})
