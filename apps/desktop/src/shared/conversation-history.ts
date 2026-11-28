import { z } from 'zod'
import type { ConversationNavigationEntry } from './conversation-navigation.ts'
import { workSectionId, type ConversationState } from './conversation-state.ts'

/** IPC 只传递普通数据；展开集合和 turn 索引在 Renderer 入口还原。 */
export interface ConversationSnapshot extends Omit<ConversationState, 'expanded' | 'turnStartBlocks'> {
  expanded: string[]
  turnStartBlocks: [string, number][]
}

export interface ConversationHistoryWindow {
  view: ConversationSnapshot
  /** 尚有更早内容时，表示本窗口之前的块数；否则为空。 */
  before: number | null
  /** 尚有更新内容时，为窗口末端的排他块索引。 */
  after: number | null
}

export interface ConversationHistorySnapshot extends ConversationHistoryWindow {
  earlierEntries: ConversationNavigationEntry[]
  reading?: ConversationHistoryWindow
}

export interface ConversationPreview {
  sessionId: string
  runtimeId: string
  history: ConversationHistorySnapshot
}

export const conversationHistoryRequestSchema = z.object({
  runtimeId: z.string().uuid(),
  location: z.union([
    z.object({ kind: z.enum(['older', 'newer']), cursor: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal('around'), id: z.string().min(1).max(512) }).strict(),
  ]),
}).strict()
export type ConversationHistoryRequest = z.infer<typeof conversationHistoryRequestSchema>
export type HistoryLocation = ConversationHistoryRequest['location']

export type ConversationHistoryResult =
  | { ok: true; history: ConversationHistoryWindow }
  | { ok: false; error: string }

/** 窗口内的块索引均从零开始；当前步骤的撤销快照使用同一边界。 */
export function conversationSnapshotRange(state: ConversationState, start: number, end = state.blocks.length): ConversationSnapshot {
  const blocks = state.blocks.slice(start, end)
  const ids = new Set(blocks.flatMap(block => [block.id, workSectionId(block, block.id)]))
  return {
    ...state,
    blocks,
    expanded: [...state.expanded].filter(id => ids.has(id)),
    turnStartBlocks: [...state.turnStartBlocks]
      .filter(([, index]) => index >= start && index < end)
      .map(([id, index]) => [id, index - start]),
    pendingTurnStart: state.pendingTurnStart !== null && state.pendingTurnStart >= start && state.pendingTurnStart < end
      ? state.pendingTurnStart - start : null,
    pendingStep: end === state.blocks.length && state.pendingStep
      ? { ...state.pendingStep, blocks: state.pendingStep.blocks.slice(start) } : null,
  }
}

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
