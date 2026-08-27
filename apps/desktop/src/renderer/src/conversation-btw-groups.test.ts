import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { BtwMode } from '@whycode/core'
import type { Block } from './conversation-state.ts'
import {
  presentBtwConversations,
  type ConversationDisplayItem,
} from './conversation-btw-groups.ts'
import { conversationSections } from './conversation-sections.ts'

describe('临时对话组展示投影', () => {
  it('第三轮已经用完时仍等待下一条用户消息再折叠', () => {
    const sections = conversationSections([
      ...btwTurn('a-1', 'conversation-a', 1, 'btw', '第一轮问题'),
      ...btwTurn('a-2', 'conversation-a', 2, 'bbtw', '第二轮问题'),
      ...btwTurn('a-3', 'conversation-a', 3, 'bbtw', '第三轮问题'),
    ])

    const presentation = presentBtwConversations(sections, new Set())

    assert.equal(presentation.latestBtwConversationId, 'conversation-a')
    assert.equal(presentation.items.some((item) => item.kind === 'btw-group'), false)
  })

  it('普通消息出现后把此前整条临时链折叠在新消息之前', () => {
    const sections = conversationSections([
      ...btwTurn('a-1', 'conversation-a', 1, 'btw', '**第一轮问题** 以及更多说明'),
      ...btwTurn('a-2', 'conversation-a', 2, 'bbtw', '继续追问'),
      user('main-next', '开始主任务'),
    ])

    const presentation = presentBtwConversations(sections, new Set())
    const group = asGroup(presentation.items[0])

    assert.equal(group.summary, '第一轮问题 以及更多说明')
    assert.deepEqual(group.sections.map((section) => section.id), ['work-a-1', 'work-a-2'])
    assert.equal(presentation.items[1]?.id, 'main-next')
    assert.equal(presentation.navigationTargetIds.get('a-1'), group.id)
    assert.equal(presentation.navigationTargetIds.get('a-2'), group.id)
  })

  it('新的 BTW 结束上一组，但当前新组保持展开', () => {
    const sections = conversationSections([
      ...btwTurn('a-1', 'conversation-a', 1, 'btw', '旧问题'),
      ...btwTurn('b-1', 'conversation-b', 1, 'btw', '新问题'),
    ])

    const presentation = presentBtwConversations(sections, new Set())

    assert.equal(presentation.latestBtwConversationId, 'conversation-b')
    assert.equal(presentation.items[0]?.kind, 'btw-group')
    assert.equal(presentation.items[1]?.kind, 'section')
  })

  it('BBTW 续接同一组时不折叠之前轮次', () => {
    const sections = conversationSections([
      ...btwTurn('a-1', 'conversation-a', 1, 'btw', '第一轮'),
      ...btwTurn('a-2', 'conversation-a', 2, 'bbtw', '第二轮'),
    ])

    const presentation = presentBtwConversations(sections, new Set())

    assert.deepEqual(presentation.items.map((item) => item.kind), ['section', 'section'])
    assert.equal(presentation.navigationTargetIds.size, 0)
  })

  it('用户展开已结束的组后恢复每轮独立锚点', () => {
    const sections = conversationSections([
      ...btwTurn('a-1', 'conversation-a', 1, 'btw', '第一轮'),
      ...btwTurn('a-2', 'conversation-a', 2, 'bbtw', '第二轮'),
      user('main-next', '继续主任务'),
    ])
    const groupId = 'btw-conversation-conversation-a'

    const presentation = presentBtwConversations(sections, new Set([groupId]))

    assert.equal(presentation.navigationTargetIds.size, 0)
    assert.equal(asGroup(presentation.items[0]).id, groupId)
  })
})

function asGroup(
  item: ConversationDisplayItem | undefined,
): Extract<ConversationDisplayItem, { kind: 'btw-group' }> {
  assert.equal(item?.kind, 'btw-group')
  return item as Extract<ConversationDisplayItem, { kind: 'btw-group' }>
}

function btwTurn(
  id: string,
  conversationId: string,
  turnIndex: number,
  mode: BtwMode,
  text: string,
): Block[] {
  return [
    {
      kind: 'user',
      id,
      inputId: `${id}-input`,
      text,
      btw: { conversationId, turnIndex, mode },
    },
    { kind: 'text', id: `${id}-answer`, text: `${id} 回答`, phase: 'final' },
    {
      kind: 'work-duration',
      id: `${id}-duration`,
      forkTurnId: null,
      durationMs: 1_000,
      outcome: 'completed',
    },
  ]
}

function user(id: string, text: string): Block {
  return { kind: 'user', id, turnId: `${id}-turn`, text }
}
