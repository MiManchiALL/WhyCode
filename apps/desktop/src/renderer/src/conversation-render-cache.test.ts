import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Block } from './conversation-state.ts'
import {
  assistantTextRenderState,
  sameConversationBlockRenderProps,
  type ConversationBlockRenderProps,
} from './conversation-render-cache.ts'

const onCheckpointRestoreChange = () => {}
const onEdit = async () => true
const onFork = () => {}
const onToggle = () => {}

function props(block: Block): ConversationBlockRenderProps {
  return {
    runtimeId: 'runtime-1',
    block,
    editable: false,
    expanded: false,
    busy: false,
    showCheckpointRestore: false,
    checkpointRestorePending: false,
    streamingAssistantText: false,
    renderMath: true,
    showAssistantActions: false,
    forkTurnId: null,
    forkPending: false,
    skills: [],
    projectDir: 'E:\\Agent\\WhyCode',
    onCheckpointRestoreChange,
    onEdit,
    onFork,
    onToggle,
  }
}

describe('对话块脏尾部渲染边界', () => {
  it('活动中的 pending 正文使用流式解析并延后完整数学排版', () => {
    const pending: Block = {
      kind: 'text', id: 'pending', text: String.raw`$$x^2$$`, phase: 'pending',
    }
    const final: Block = { ...pending, phase: 'final' }

    assert.deepEqual(assistantTextRenderState(pending), {
      streamingAssistantText: true,
      renderMath: false,
    })
    assert.deepEqual(assistantTextRenderState(final), {
      streamingAssistantText: false,
      renderMath: true,
    })
  })

  it('保留未变化历史块的渲染结果', () => {
    const block: Block = { kind: 'text', id: 'answer', text: '完成', phase: 'final' }
    const previous = props(block)
    const next = { ...previous, onEdit: async () => false }

    assert.equal(sameConversationBlockRenderProps(previous, next), true)
  })

  it('块身份、展开状态和正文流式状态变化时重新渲染', () => {
    const block: Block = { kind: 'text', id: 'answer', text: '完成', phase: 'final' }
    const previous = props(block)

    assert.equal(sameConversationBlockRenderProps(previous, {
      ...previous,
      block: { ...block, text: '继续' },
    }), false)
    assert.equal(sameConversationBlockRenderProps(previous, {
      ...previous,
      expanded: true,
    }), false)
    assert.equal(sameConversationBlockRenderProps(previous, {
      ...previous,
      streamingAssistantText: true,
    }), false)
    assert.equal(sameConversationBlockRenderProps(previous, {
      ...previous,
      renderMath: false,
    }), false)
  })

  it('只让最新可编辑用户消息响应忙闲状态', () => {
    const block: Block = { kind: 'user', id: 'user', text: '问题' }
    const inactive = props(block)
    assert.equal(sameConversationBlockRenderProps(inactive, {
      ...inactive,
      busy: true,
      onEdit: async () => false,
    }), true)

    const editable = { ...inactive, editable: true }
    assert.equal(sameConversationBlockRenderProps(editable, {
      ...editable,
      busy: true,
    }), false)
  })

  it('只让回滚入口响应恢复状态', () => {
    const block: Block = {
      kind: 'tool',
      id: 'tool',
      call: {
        id: 'call-1',
        name: 'WriteFile',
        input: {},
        status: 'done',
        progress: '',
      },
    }
    const previous = { ...props(block), showCheckpointRestore: true }
    assert.equal(sameConversationBlockRenderProps(previous, {
      ...previous,
      checkpointRestorePending: true,
    }), false)
  })
})
