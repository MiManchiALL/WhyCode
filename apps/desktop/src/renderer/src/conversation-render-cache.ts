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
  onEdit: (turnId: string, text: string) => Promise<boolean>
  onFork: (turnId: string) => void
  onToggle: (id: string) => void
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
