import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ModelMessage } from 'ai'
import type { ViewEvent } from '../session/view-events.ts'
import { latestTurnEditResources } from './turn-edit.ts'

describe('最新根消息编辑资格', () => {
  const rootAndTurn: ViewEvent[] = [
    { type: 'user-message', inputId: 'input-old', text: '旧问题', startsTurn: true },
    { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-old' } },
  ]
  const messages: ModelMessage[] = [
    { role: 'user', content: '旧问题' },
    { role: 'assistant', content: '已完成的回答' },
  ]

  it('已完成或已停止的最新回合都返回原根附件资源', () => {
    assert.deepEqual(
      latestTurnEditResources(messages, rootAndTurn, 'turn-old', 0),
      { attachments: [], pdfAttachments: [] },
    )
  })

  it('出现更新回合后禁止改写旧消息', () => {
    assert.throws(
      () => latestTurnEditResources(messages, [
        ...rootAndTurn,
        { type: 'user-message', inputId: 'input-new', text: '新问题', startsTurn: true },
        { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-new' } },
      ], 'turn-old', 0),
      /只能编辑最新/,
    )
  })

  it('同一协商根的后续内部 turn 不遮蔽首个可见 turn 身份', () => {
    const events: ViewEvent[] = [
      ...rootAndTurn,
      { type: 'core-event', event: { type: 'turn-start', turnId: 'turn-execute' } },
    ]
    assert.deepEqual(
      latestTurnEditResources(messages, events, 'turn-old', 0),
      { attachments: [], pdfAttachments: [] },
    )
    assert.throws(
      () => latestTurnEditResources(messages, events, 'turn-execute', 0),
      /只能编辑最新/,
    )
  })
})
