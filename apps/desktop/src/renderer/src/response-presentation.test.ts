import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ViewEvent } from '@whycode/core'
import type { Presentation } from '@whycode/core/presentation'
import { applyCoreEvent, createConversationState, type Block, type ToolCall } from '../../shared/conversation-state.ts'
import { conversationSections } from '../../shared/conversation-sections.ts'
import { copyResponseText, responsePresentationResult, responseSources } from './response-presentation.ts'

const declaration: Presentation = {
  files: [{ path: 'C:/work/index.html', description: '网页成品' }],
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
    assert.equal(responsePresentationResult([block(call)]), call.result)
    for (const changed of [
      { ...call, name: 'ReadFile' }, { ...call, status: 'error' as const },
      { ...call, status: 'running' as const }, { ...call, result: undefined, input: declaration },
      { ...call, result: '{"files":[' },
    ]) assert.equal(responsePresentationResult([block(changed)]), null)
  })

  it('最近一次成功声明完整替换旧声明，允许清空；失败保留之前的结果', () => {
    const empty = { ...call, id: 'clear', result: JSON.stringify({ files: [] }) }
    const failed = { ...call, id: 'failed', status: 'error' as const }
    assert.equal(responsePresentationResult([block(call), block(failed)]), call.result)
    assert.equal(responsePresentationResult([block(call), block(empty)]), empty.result)
  })

  it('序列化重放保留本回答声明，下一回答和新会话不会继承', () => {
    const events = [...responseEvents('a', true), ...responseEvents('b', false)]
    const replay = createConversationState(JSON.parse(JSON.stringify(events)))
    const sections = conversationSections(replay.blocks)
    const presentations = sections.filter(section => section.kind !== 'block').map(section => responsePresentationResult(section.activityBlocks))
    assert.deepEqual(presentations, [call.result, null])
    assert.deepEqual(conversationSections(createConversationState().blocks), [])
  })

  it('被中断并丢弃的步骤不会留下可交付记录', () => {
    let state = createConversationState([{ type: 'user-message', text: '任务', startsTurn: true }])
    state = applyCoreEvent(state, { type: 'tool-start', toolUseId: 'p', toolName: 'Present', input: declaration })
    state = applyCoreEvent(state, { type: 'tool-end', toolUseId: 'p', result: JSON.stringify(declaration), isError: false })
    assert.equal(responsePresentationResult(state.blocks), call.result)
    state = applyCoreEvent(state, { type: 'step-discarded' })
    assert.equal(responsePresentationResult(state.blocks), null)
  })

  it('复制正文时补齐文件与来源，保留锚点并转义标题', () => {
    assert.equal(copyResponseText(responseSources(['结论']), null), '结论')
    const response = responseSources(['结论 [规范 \\[正式版\\]](https://example.com/spec#entry "whycode:source")'])
    assert.equal(copyResponseText(response, declaration), '结论 [规范 \\[正式版\\]](<https://example.com/spec#entry>)\n\n- [index.html](<C:/work/index.html>) — 网页成品\n\n### 来源\n\n- [规范 \\[正式版\\]](<https://example.com/spec#entry>)')
  })

  it('不依赖 Present 汇总每处显式引用，按首次出现去重并保留不同片段', () => {
    const text = '[第一个来源](https://EXAMPLE.com:443/docs "whycode:source") '
      + '[同一来源](https://example.com/docs "whycode:source") '
      + '[普通入口](https://example.com/docs) '
      + '[第二个来源](https://example.com/docs#part "whycode:source")'
    assert.deepEqual(responseSources([text]).sources, [
      { title: '第一个来源', url: 'https://example.com/docs' },
      { title: '第二个来源', url: 'https://example.com/docs#part' },
    ])
    assert.deepEqual(responseSources(['[普通入口](https://example.com/docs)']).sources, [])
    assert.deepEqual(responseSources([]), { sources: [], copyText: '' })
  })

  it('每个正文块按自身 Markdown 边界解析，来源在本回答内汇总', () => {
    const text = '[文档](https://example.com/docs "whycode:source")'
    assert.deepEqual(responseSources(['```md\n' + text, text]).sources, [
      { title: '文档', url: 'https://example.com/docs' },
    ])
    assert.deepEqual(responseSources(['[说明][docs]', '[docs]: https://example.com/docs "whycode:source"']).sources, [])
  })

  it('复制移除有效引用的内部标记，保留普通链接、代码样例和定义式链接', () => {
    const text = '[**接口** `v2`](https://example.com/api "whycode:source") '
      + '[控制台](https://example.com/console "控制台")\n\n'
      + '[规范][docs]\n\n[docs]: https://example.com/docs "whycode:source"\n\n'
      + '`[示例](https://example.com/code "whycode:source")`'
    const response = responseSources([text])
    assert.equal(response.copyText, '[接口 v2](<https://example.com/api>) '
      + '[控制台](https://example.com/console "控制台")\n\n'
      + '[规范](<https://example.com/docs>)\n\n[docs]: <https://example.com/docs>\n\n'
      + '`[示例](https://example.com/code "whycode:source")`')
    assert.equal(response.sources.length, 2)
  })

  it('数学规范化不把公式内的链接当作引用', () => {
    const link = '[文档](https://example.com/docs "whycode:source")'
    assert.deepEqual(responseSources(['\\(' + link + '\\)']).sources, [])
    assert.deepEqual(responseSources(['\\[\n' + link + '\n\\]']).sources, [])
  })
})
