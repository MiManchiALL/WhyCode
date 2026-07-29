import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import { createTurnAbortedMessage } from '../session/interruption.ts'
import type { ViewEvent } from '../session/view-events.ts'
import { stoppedTurnEditResources } from './turn-edit.ts'

describe('已停止回合编辑资格', () => {
  const rootAndTurn: ViewEvent[] = [
    { type: 'user-message', inputId: 'input-old', text: '旧问题', startsTurn: true },
    { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-old' } },
  ]
  const messages: ModelMessage[] = [
    { role: 'user', content: '旧问题' },
    createTurnAbortedMessage(),
  ]

  it('仅有停止标记时返回原根消息的附件资源', () => {
    assert.deepEqual(
      stoppedTurnEditResources(messages, rootAndTurn, 'turn-old', 0),
      { attachments: [], pdfAttachments: [] },
    )
  })

  it('保留过流式正文或提交过模型消息后禁止原位编辑', () => {
    assert.throws(
      () => stoppedTurnEditResources(messages, [
        ...rootAndTurn,
        { type: 'core-event', event: { type: 'text-delta', text: '部分回答' } },
      ], 'turn-old', 0),
      /已有可见输出/,
    )
    assert.throws(
      () => stoppedTurnEditResources([
        { role: 'user', content: '旧问题' },
        { role: 'assistant', content: '稳定回答' },
        createTurnAbortedMessage(),
      ], rootAndTurn, 'turn-old', 0),
      /已有稳定模型输出/,
    )
  })
})
