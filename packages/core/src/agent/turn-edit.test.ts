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
      { turnIds: ['turn-old'], attachments: [], pdfAttachments: [] },
    )
  })

  it('普通插话不取代根消息，独立 BTW 输入仍会取代它', () => {
    const steering: ViewEvent = { type: 'user-message', text: '补充条件', startsTurn: false }
    assert.deepEqual(latestTurnEditResources(messages, [...rootAndTurn, steering], 'turn-old', 0).turnIds, ['turn-old'])
    const btw: ViewEvent = { ...steering, inputId: 'side', btw: { conversationId: 'side', turnIndex: 1, mode: 'btw' } }
    assert.throws(() => latestTurnEditResources(messages, [...rootAndTurn, btw], 'turn-old', 0), /只能编辑最新/)
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
      { turnIds: ['turn-old', 'turn-execute'], attachments: [], pdfAttachments: [] },
    )
    assert.throws(
      () => latestTurnEditResources(messages, events, 'turn-execute', 0),
      /只能编辑最新/,
    )
  })
})
