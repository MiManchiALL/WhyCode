import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CoreEvent } from '@whycode/core/events'
import { isBackgroundRuntimeLifecycleEvent } from './runtime-event-delivery.ts'

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
      assert.equal(isBackgroundRuntimeLifecycleEvent(event), true)
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
      assert.equal(isBackgroundRuntimeLifecycleEvent(event), false)
    }
  })
})
