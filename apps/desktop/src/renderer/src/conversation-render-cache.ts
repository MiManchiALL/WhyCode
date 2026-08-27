import type { Block } from './conversation-state.ts'

export interface ConversationBlockRenderProps {
  runtimeId: string
  block: Block
  editable: boolean
  expanded: boolean
  busy: boolean
  showCheckpointRestore: boolean
  checkpointRestorePending: boolean
  streamingAssistantText: boolean
  renderMath: boolean
  showAssistantActions: boolean
  forkTurnId: string | null
  forkPending: boolean
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onEdit: (block: Extract<Block, { kind: 'user' }>, text: string) => Promise<boolean>
  onFork: (turnId: string) => void
  onToggle: (id: string) => void
}

const STREAMING_ASSISTANT_TEXT = {
  streamingAssistantText: true,
  renderMath: false,
} as const
const SETTLED_ASSISTANT_TEXT = {
  streamingAssistantText: false,
  renderMath: true,
} as const

/** 未提交正文仍可能继续调用工具；只改变渲染成本，不提前改变其协议分类。 */
export function assistantTextRenderState(
  block: Block,
): Pick<ConversationBlockRenderProps, 'streamingAssistantText' | 'renderMath'> {
  return block.kind === 'text' && block.phase === 'pending'
    ? STREAMING_ASSISTANT_TEXT
    : SETTLED_ASSISTANT_TEXT
}

/**
 * Core 事件只会替换发生变化的块。这里保留该身份边界，避免流式尾部更新时
 * 重新渲染整段历史；只比较当前块实际会读取的交互状态。
 */
export function sameConversationBlockRenderProps(
  previous: ConversationBlockRenderProps,
  next: ConversationBlockRenderProps,
): boolean {
  if (
    previous.block !== next.block
    || previous.expanded !== next.expanded
    || previous.streamingAssistantText !== next.streamingAssistantText
    || previous.renderMath !== next.renderMath
    || previous.showAssistantActions !== next.showAssistantActions
    || previous.forkTurnId !== next.forkTurnId
    || previous.forkPending !== next.forkPending
    || previous.onFork !== next.onFork
    || previous.onToggle !== next.onToggle
  ) {
    return false
  }

  if (next.block.kind === 'user') {
    if (
      previous.runtimeId !== next.runtimeId
      || previous.editable !== next.editable
    ) {
      return false
    }
    return !next.editable || (
      previous.busy === next.busy
      && previous.onEdit === next.onEdit
    )
  }

  if (next.block.kind === 'tool') {
    if (
      previous.showCheckpointRestore !== next.showCheckpointRestore
      || previous.checkpointRestorePending !== next.checkpointRestorePending
    ) {
      return false
    }
    return !next.showCheckpointRestore || (
      previous.runtimeId === next.runtimeId
      && previous.busy === next.busy
      && previous.onCheckpointRestoreChange === next.onCheckpointRestoreChange
    )
  }

  return true
}
