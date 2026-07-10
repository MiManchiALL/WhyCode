import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import { createConversationState } from './conversation-state.ts'

describe('会话界面时间线重建', () => {
  it('按原顺序恢复用户、思考、工具、候选和 B/C 卡片', () => {
    const state = createConversationState([
      { type: 'user-message', text: '分析项目', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-1' }),
      core({ type: 'thinking-delta', text: '先查看结构' }),
      core({ type: 'thinking-end', durationMs: 1200 }),
      core({ type: 'tool-start', toolUseId: 'tool-1', toolName: 'ListDir', input: { path: '.' } }),
      core({ type: 'tool-end', toolUseId: 'tool-1', result: 'app\nREADME.md', isError: false }),
      core({
        type: 'candidate-submitted',
        agentId: 'Main',
        candidateId: 'M1',
        summary: '这是一个桌面 Agent 项目',
      }),
      core({
        type: 'peer-event',
        agentId: 'B',
        event: { type: 'text-delta', text: 'B 的独立分析' },
      }),
      core({
        type: 'vote-cast',
        from: 'B',
        target: 'M1',
        vote: 'accept',
        reason: '结论正确',
      }),
      core({ type: 'text-delta', text: '最终回答' }),
    ])

    assert.deepEqual(state.blocks.map((block) => block.kind), [
      'user',
      'thinking',
      'tool',
      'candidate',
      'peer',
      'text',
    ])
    assert.equal(state.blocks.find((block) => block.kind === 'tool')?.call.status, 'done')
    const peer = state.blocks.find((block) => block.kind === 'peer')
    assert.equal(peer?.kind === 'peer' ? peer.peer.status : null, 'done')
    assert.match(JSON.stringify(state.blocks), /B 的独立分析/)
  })

  it('重放文件和对话回滚时删除对应 turn 的可见内容', () => {
    const state = createConversationState([
      { type: 'user-message', text: '保留的旧问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-old' }),
      core({ type: 'text-delta', text: '旧回答' }),
      { type: 'user-message', text: '需要回滚的问题', startsTurn: true },
      core({ type: 'turn-start', turnId: 'turn-new' }),
      core({ type: 'tool-start', toolUseId: 'tool-2', toolName: 'EditFile', input: {} }),
      core({ type: 'tool-end', toolUseId: 'tool-2', result: 'ok', isError: false }),
      core({
        type: 'checkpoint-restored',
        toolUseId: 'tool-2',
        turnId: 'turn-new',
        scope: 'files-and-chat',
        ok: true,
      }),
    ])

    assert.match(JSON.stringify(state.blocks), /保留的旧问题/)
    assert.doesNotMatch(JSON.stringify(state.blocks), /需要回滚的问题/)
    assert.match(JSON.stringify(state.blocks), /已回滚/)
  })
})

function core(event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent {
  return { type: 'core-event', event }
}
