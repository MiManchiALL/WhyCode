import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  conversationSections,
  shouldShowComposerProcessingTime,
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
    assert.equal(completed.id, 'work-user-1')
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

  it('运行中的尾部尚无最终正文时保持原始逐块展示', () => {
    const blocks = [
      user('user-1', 'turn-1'),
      thinking('thinking-1'),
      tool('tool-1'),
    ]
    const sections = conversationSections(blocks, 1_000)

    assert.deepEqual(sections.map((section) => section.kind), ['block', 'block', 'block'])
    assert.deepEqual(sections.map((section) => section.id), ids(blocks))
  })

  it('纯文本 step 确认提交后把运行中的处理过程投影为折叠区', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      thinking('thinking-1'),
      tool('tool-1'),
      text('answer', '正在流式输出最终回答'),
    ], 1_000)

    const active = asActive(sections[0])
    assert.equal(active.id, 'work-user-1')
    assert.equal(active.startedAt, 1_000)
    assert.deepEqual(ids(active.userBlocks), ['user-1'])
    assert.deepEqual(ids(active.activityBlocks), ['thinking-1', 'tool-1'])
    assert.deepEqual(ids(active.finalBlocks), ['answer'])
  })

  it('尚未提交的正文不猜测为最终回答，继续保持运行过程展开', () => {
    const blocks = [
      user('user-1', 'turn-1'),
      thinking('thinking-1'),
      pendingText('pending-answer', '可能仍会继续调用工具'),
    ]
    const sections = conversationSections(blocks, 1_000)

    assert.deepEqual(sections.map((section) => section.kind), ['block', 'block', 'block'])
    assert.deepEqual(sections.map((section) => section.id), ids(blocks))
  })

  it('活动任务摘要出现后只保留摘要内计时，不再显示输入区计时', () => {
    const runningSections = conversationSections([
      user('user-1', 'turn-1'),
      tool('tool-1'),
    ], 1_000)
    const activeSections = conversationSections([
      user('user-1', 'turn-1'),
      tool('tool-1'),
      text('answer', '正在流式输出最终回答'),
    ], 1_000)

    assert.equal(shouldShowComposerProcessingTime(null, runningSections), false)
    assert.equal(shouldShowComposerProcessingTime(1_000, runningSections), true)
    assert.equal(shouldShowComposerProcessingTime(1_000, activeSections), false)
  })

  it('正文后继续调用工具时恢复运行中逐块展示', () => {
    const blocks = [
      user('user-1', 'turn-1'),
      text('commentary', '再检查一个文件'),
      tool('tool-1'),
    ]
    const sections = conversationSections(blocks, 1_000)

    assert.deepEqual(sections.map((section) => section.kind), ['block', 'block', 'block'])
    assert.deepEqual(sections.map((section) => section.id), ids(blocks))
  })

  it('work-finished 到达后沿用同一任务折叠身份并冻结时长', () => {
    const active = asActive(conversationSections([
      user('user-1', 'turn-1'),
      tool('tool-1'),
      text('answer', '最终回答'),
    ], 1_000)[0])
    const completed = asCompleted(conversationSections([
      user('user-1', 'turn-1'),
      tool('tool-1'),
      text('answer', '最终回答'),
      duration('duration-1'),
    ])[0])

    assert.equal(active.id, completed.id)
    assert.equal(completed.duration.durationMs, 61_000)
  })

  it('按工作时长边界逐个投影多个已完成任务', () => {
    const sections = conversationSections([
      user('user-1', 'turn-1'),
      text('answer-1', '第一轮'),
      duration('duration-1'),
      user('user-2', 'turn-2'),
      text('answer-2', '第二轮'),
      duration('duration-2'),
      user('user-3', 'turn-3'),
      tool('tool-3'),
    ])

    assert.deepEqual(
      sections.map((section) => [section.kind, section.id]),
      [
        ['completed-work', 'work-user-1'],
        ['completed-work', 'work-user-2'],
        ['block', 'user-3'],
        ['block', 'tool-3'],
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

  it('把下一轮开始前的回滚通知留在用户消息上方', () => {
    const sections = conversationSections([
      notice('rollback', '已回滚：该轮对话与文件改动均已撤销'),
      user('user-1', 'turn-1'),
      thinking('thinking-1'),
      text('answer', '你好'),
      duration('duration-1'),
    ])

    assert.deepEqual(
      sections.map((section) => [section.kind, section.id]),
      [
        ['block', 'rollback'],
        ['completed-work', 'work-user-1'],
      ],
    )
    const completed = asCompleted(sections[1])
    assert.deepEqual(ids(completed.userBlocks), ['user-1'])
    assert.deepEqual(ids(completed.activityBlocks), ['thinking-1'])
    assert.deepEqual(ids(completed.finalBlocks), ['answer'])
  })

  it('用户停止任务后仍生成可折叠工作区，并保留工具、模型输出和停止终态', () => {
    const blocks = [
      user('user-1', 'turn-1'),
      thinking('thinking-1'),
      tool('tool-1'),
      text('partial-answer', '尚未完成的阶段输出'),
      duration('duration-1', 'stopped'),
    ]

    const sections = conversationSections(blocks)

    const stopped = asCompleted(sections[0])
    assert.equal(stopped.id, 'work-user-1')
    assert.equal(stopped.duration.outcome, 'stopped')
    assert.deepEqual(ids(stopped.userBlocks), ['user-1'])
    assert.deepEqual(ids(stopped.activityBlocks), ['thinking-1', 'tool-1'])
    assert.deepEqual(ids(stopped.finalBlocks), ['partial-answer'])
  })
})

function asCompleted(
  section: ConversationSection | undefined,
): Extract<ConversationSection, { kind: 'completed-work' }> {
  assert.equal(section?.kind, 'completed-work')
  return section as Extract<ConversationSection, { kind: 'completed-work' }>
}

function asActive(
  section: ConversationSection | undefined,
): Extract<ConversationSection, { kind: 'active-work' }> {
  assert.equal(section?.kind, 'active-work')
  return section as Extract<ConversationSection, { kind: 'active-work' }>
}

function ids(blocks: readonly Block[]): string[] {
  return blocks.map((block) => block.id)
}

function user(id: string, turnId?: string): Block {
  return { kind: 'user', id, text: id, ...(turnId ? { turnId } : {}) }
}

function text(id: string, value: string): Block {
  return { kind: 'text', id, text: value, phase: 'final' }
}

function pendingText(id: string, value: string): Block {
  return { kind: 'text', id, text: value, phase: 'pending' }
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

function notice(id: string, text: string): Block {
  return { kind: 'notice', id, text }
}

function duration(
  id: string,
  outcome: Extract<Block, { kind: 'work-duration' }>['outcome'] = 'completed',
): Block {
  return { kind: 'work-duration', id, durationMs: 61_000, outcome }
}
