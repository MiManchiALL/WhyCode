import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import type { Presentation } from '@whycode/core/presentation'
import { applyCoreEvent, createConversationState, type Block, type ToolCall } from '../../shared/conversation-state.ts'
import { conversationSections } from '../../shared/conversation-sections.ts'
import { copyResponseText, responsePresentation, toolPresentation } from './response-presentation.ts'

const declaration: Presentation = {
  files: [{ path: 'C:/work/index.html', description: '网页成品' }],
  sources: [{ title: '规范 [正式版]', url: 'https://example.com/spec#entry' }],
}
const call: ToolCall = { id: 'present', name: 'Present', input: {}, status: 'done', result: JSON.stringify(declaration), progress: '' }
const block = (value: ToolCall): Block => ({ kind: 'tool', id: value.id, call: value })
const core = (event: Extract<ViewEvent, { type: 'core-event' }>['event']): ViewEvent => ({ type: 'core-event', event })

function responseEvents(id: string, present: boolean): ViewEvent[] {
  return [
    { type: 'user-message', text: '请求 ' + id, startsTurn: true },
    core({ type: 'turn-start', turnId: id }),
    ...(present ? [
      core({ type: 'tool-start', toolUseId: id + '-present', toolName: 'Present', input: declaration }),
      core({ type: 'tool-end', toolUseId: id + '-present', result: JSON.stringify(declaration), isError: false }),
    ] : []),
    core({ type: 'text-delta', text: '完成 ' + id }),
    core({ type: 'work-finished', durationMs: 10, outcome: 'completed', forkTurnId: id }),
  ]
}

describe('最终回答的交付投影', () => {
  it('只相信成功工具结果，忽略输入、普通工具、失败和截断结果', () => {
    assert.deepEqual(toolPresentation(call), declaration)
    for (const changed of [
      { ...call, name: 'ReadFile' }, { ...call, status: 'error' as const },
      { ...call, status: 'running' as const }, { ...call, result: undefined, input: declaration },
      { ...call, result: '{"files":[' },
    ]) assert.equal(toolPresentation(changed), null)
  })

  it('最近一次成功声明完整替换旧声明，允许清空；失败保留之前的结果', () => {
    const empty = { ...call, id: 'clear', result: JSON.stringify({ files: [], sources: [] }) }
    const failed = { ...call, id: 'failed', status: 'error' as const }
    assert.deepEqual(responsePresentation([block(call), block(failed)]), declaration)
    assert.deepEqual(responsePresentation([block(call), block(empty)]), { files: [], sources: [] })
  })

  it('序列化重放保留本回答声明，下一回答和新会话不会继承', () => {
    const events = [...responseEvents('a', true), ...responseEvents('b', false)]
    const replay = createConversationState(JSON.parse(JSON.stringify(events)))
    const sections = conversationSections(replay.blocks)
    const presentations = sections.filter(section => section.kind !== 'block').map(section => responsePresentation(section.activityBlocks))
    assert.deepEqual(presentations, [declaration, null])
    assert.deepEqual(conversationSections(createConversationState().blocks), [])
  })

  it('被中断并丢弃的步骤不会留下可交付记录', () => {
    let state = createConversationState([{ type: 'user-message', text: '任务', startsTurn: true }])
    state = applyCoreEvent(state, { type: 'tool-start', toolUseId: 'p', toolName: 'Present', input: declaration })
    state = applyCoreEvent(state, { type: 'tool-end', toolUseId: 'p', result: JSON.stringify(declaration), isError: false })
    assert.deepEqual(responsePresentation(state.blocks), declaration)
    state = applyCoreEvent(state, { type: 'step-discarded' })
    assert.equal(responsePresentation(state.blocks), null)
  })

  it('复制正文时补齐文件与来源，保留锚点并转义标题', () => {
    assert.equal(copyResponseText('结论', null), '结论')
    assert.equal(copyResponseText('结论', declaration), '结论\n\n- [index.html](<C:/work/index.html>) — 网页成品\n\n### 来源\n\n- [规范 \\[正式版\\]](<https://example.com/spec#entry>)')
  })
})
