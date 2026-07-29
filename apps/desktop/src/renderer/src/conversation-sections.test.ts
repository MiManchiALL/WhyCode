import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  conversationSections,
  type ConversationSection,
} from './conversation-sections.ts'

describe('已完成任务的会话展示投影', () => {
  it('把处理过程折叠在时长标题下，并把最终回答留在标题之后', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      text('commentary', '先检查项目'),
      thinking('thinking-1'),
      tool('tool-1'),
      text('answer', '已完成'),
      duration('duration-1'),
    ])

    const completed = asCompleted(sections[0])
    assert.deepEqual(ids(completed.userBlocks), ['user-1'])
    assert.deepEqual(ids(completed.activityBlocks), ['commentary', 'thinking-1', 'tool-1'])
    assert.deepEqual(ids(completed.finalBlocks), ['answer'])
    assert.equal(completed.id, 'duration-1')
    assert.equal(completed.duration.durationMs, 61_000)
  })

  it('直接回答仍把固定时长放到最终回答前，但没有伪造可展开内容', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      text('answer', '答案'),
      duration('duration-1'),
    ])

    const completed = asCompleted(sections[0])
    assert.deepEqual(completed.activityBlocks, [])
    assert.deepEqual(ids(completed.finalBlocks), ['answer'])
  })

  it('没有最终正文时把全部模型活动保留为可展开过程', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      thinking('thinking-1'),
      tool('tool-1'),
      duration('duration-1'),
    ])

    const completed = asCompleted(sections[0])
    assert.deepEqual(ids(completed.activityBlocks), ['thinking-1', 'tool-1'])
    assert.deepEqual(completed.finalBlocks, [])
  })

  it('把同一连续任务中的用户插话留在折叠区外', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      tool('tool-1'),
      user('steering-1'),
      text('answer', '按新约束完成'),
      duration('duration-1'),
    ])

    const completed = asCompleted(sections[0])
    assert.deepEqual(ids(completed.userBlocks), ['user-1', 'steering-1'])
    assert.deepEqual(ids(completed.activityBlocks), ['tool-1'])
    assert.deepEqual(ids(completed.finalBlocks), ['answer'])
  })

  it('用户插话会切断此前正文，只有插话后的终态正文留在折叠区外', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      text('earlier-text', '插话前的阶段回复'),
      user('steering-1'),
      text('answer', '按新约束完成'),
      duration('duration-1'),
    ])

    const completed = asCompleted(sections[0])
    assert.deepEqual(ids(completed.activityBlocks), ['earlier-text'])
    assert.deepEqual(ids(completed.finalBlocks), ['answer'])
  })

  it('运行中的尾部任务保持原始逐块展示，直到 work-finished 到达', () => {
    const blocks = [
      user('user-1', 'turn-1'),
      thinking('thinking-1'),
      tool('tool-1'),
    ]
    const sections = conversationSections(blocks)

    assert.deepEqual(sections.map((section) => section.kind), ['block', 'block', 'block'])
    assert.deepEqual(sections.map((section) => section.id), ids(blocks))
  })

  it('逐个投影多个已完成任务，并兼容没有根 turn 锚点的旧时长块', () => {
    const sections = conversationSections([
      text('legacy-text', '旧记录'),
      duration('legacy-duration'),
      user('user-1', 'turn-1'),
      text('answer-1', '第一轮'),
      duration('duration-1'),
      user('user-2', 'turn-2'),
      tool('tool-2'),
    ])

    assert.deepEqual(
      sections.map((section) => [section.kind, section.id]),
      [
        ['block', 'legacy-text'],
        ['block', 'legacy-duration'],
        ['completed-work', 'duration-1'],
        ['block', 'user-2'],
        ['block', 'tool-2'],
      ],
    )
  })

  it('让终态错误与相邻正文一起保持可见', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      tool('tool-1'),
      text('answer', '已完成主要步骤'),
      error('error-1'),
      duration('duration-1'),
    ])

    const completed = asCompleted(sections[0])
    assert.deepEqual(ids(completed.activityBlocks), ['tool-1'])
    assert.deepEqual(ids(completed.finalBlocks), ['answer', 'error-1'])
  })
})

function asCompleted(
  section: ConversationSection | undefined,
): Extract<ConversationSection, { kind: 'completed-work' }> {
  assert.equal(section?.kind, 'completed-work')
  return section as Extract<ConversationSection, { kind: 'completed-work' }>
}

function ids(blocks: readonly Block[]): string[] {
  return blocks.map((block) => block.id)
}

function user(id: string, turnId?: string): Block {
  return { kind: 'user', id, text: id, ...(turnId ? { turnId } : {}) }
}

function text(id: string, value: string): Block {
  return { kind: 'text', id, text: value }
}

function thinking(id: string): Block {
  return { kind: 'thinking', id, text: '分析', durationMs: 500 }
}

function tool(id: string): Block {
  return {
    kind: 'tool',
    id,
    call: {
      id,
      name: 'ReadFile',
      input: { path: 'README.md' },
      status: 'done',
      result: 'ok',
      progress: '',
    },
  }
}

function error(id: string): Block {
  return { kind: 'error', id, text: '失败' }
}

function duration(id: string): Block {
  return { kind: 'work-duration', id, durationMs: 61_000 }
}
