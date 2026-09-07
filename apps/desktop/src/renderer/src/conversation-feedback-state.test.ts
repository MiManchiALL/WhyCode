import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { CoreEvent } from '@whycode/core/events'
import { applyCoreEvent, createConversationState } from './conversation-state.ts'
import {
  expireConversationFeedback,
  holdConversationFeedback,
  releaseConversationFeedback,
  conversationEventFeedback,
} from './conversation-feedback-state.ts'

describe('对话即时提示生命周期', () => {
  it('运行提醒交给浮动提示，不生成对话历史块', () => {
    const events: CoreEvent[] = [
      { type: 'error', message: '附件能力不可用', recoverable: true },
      { type: 'checkpoint-disabled', reason: '检查点不可用' },
      { type: 'context-compacted', level: 'full', preTokens: 12_000, postTokens: 4_000 },
      { type: 'consensus-skipped', reason: 'image-input' },
      { type: 'negotiation-started', taskId: 'task', mode: 'quick_review' },
      { type: 'round-started', taskId: 'task', round: 2 },
      { type: 'execution-started', taskId: 'task' },
    ]
    const view = events.reduce((state, event) => applyCoreEvent(state, event), createConversationState())
    assert.deepEqual(view.blocks, [])
    assert.deepEqual(events.map((event) => conversationEventFeedback(event)?.tone),
      ['error', 'info', 'success', 'info', 'info', 'info', 'info'])
    assert.equal(conversationEventFeedback({ type: 'text-delta', text: '正文' }), null)
  })

  it('三秒内悬浮会保持，离开后立即进入退出', () => {
    assert.equal(holdConversationFeedback('visible'), 'held')
    assert.equal(expireConversationFeedback('held'), 'held')
    assert.equal(releaseConversationFeedback('held'), 'exiting')
  })

  it('退出开始后悬浮与离开都不能恢复常驻', () => {
    assert.equal(holdConversationFeedback('exiting'), 'exiting')
    assert.equal(releaseConversationFeedback('exiting'), 'exiting')
  })

  it('未悬浮时到期后正常退出', () => {
    assert.equal(expireConversationFeedback('visible'), 'exiting')
  })
})
