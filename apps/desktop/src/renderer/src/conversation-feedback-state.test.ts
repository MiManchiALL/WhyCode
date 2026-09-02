import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  expireConversationFeedback,
  holdConversationFeedback,
  releaseConversationFeedback,
} from './conversation-feedback-state.ts'

describe('对话即时提示生命周期', () => {
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
