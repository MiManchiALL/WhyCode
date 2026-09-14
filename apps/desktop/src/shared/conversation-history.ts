import type { ConversationNavigationEntry } from './conversation-navigation.ts'
import type { ConversationState } from './conversation-state.ts'

/** IPC 只传递普通数据；展开集合和 turn 索引在 Renderer 入口还原。 */
export interface ConversationSnapshot extends Omit<ConversationState, 'expanded' | 'turnStartBlocks'> {
  expanded: string[]
  turnStartBlocks: [string, number][]
}

export interface ConversationHistoryWindow {
  view: ConversationSnapshot
  /** 尚有更早内容时，表示本窗口之前的块数；否则为空。 */
  before: number | null
  earlierEntries: ConversationNavigationEntry[]
}

export interface ConversationHistoryRequest {
  runtimeId: string
  before: number
  targetId?: string
}

export type ConversationHistoryResult =
  | { ok: true; history: ConversationHistoryWindow }
  | { ok: false; error: string }

export function restoreConversationSnapshot(snapshot: ConversationSnapshot): ConversationState {
  return {
    ...snapshot,
    expanded: new Set(snapshot.expanded),
    turnStartBlocks: new Map(snapshot.turnStartBlocks),
  }
}

/** 旧页只扩展已展示历史，实时尾部和当前控制状态仍由原状态持有。 */
export function prependConversationHistory(
  current: ConversationState,
  page: ConversationSnapshot,
): ConversationState {
  const count = page.blocks.length
  return {
    ...current,
    blocks: [...page.blocks, ...current.blocks],
    expanded: new Set([...page.expanded, ...current.expanded]),
    turnStartBlocks: new Map([
      ...page.turnStartBlocks,
      ...[...current.turnStartBlocks].map(([id, index]): [string, number] => [id, index + count]),
    ]),
    pendingTurnStart: current.pendingTurnStart === null ? null : current.pendingTurnStart + count,
    pendingStep: current.pendingStep
      ? { ...current.pendingStep, blocks: [...page.blocks, ...current.pendingStep.blocks] }
      : null,
  }
}
