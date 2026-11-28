import { workSectionId, type Block, type ConversationState } from './conversation-state.ts'
import { conversationSections } from './conversation-sections.ts'
import { conversationNavigationEntries } from './conversation-navigation.ts'
import { conversationSnapshotRange, type ConversationHistorySnapshot, type ConversationHistoryWindow, type HistoryLocation } from './conversation-history.ts'

const WORKS_PER_PAGE = 6

/** 索引只保留完整工作的边界和定位 ID；投影被替换或运行时卸载后可整体回收。 */
const indexes = new WeakMap<readonly Block[], { starts: number[]; groups: Map<string, number> }>()

function historyIndex(blocks: readonly Block[]) {
  const cached = indexes.get(blocks)
  if (cached) return cached
  const starts = [0]
  let boundary = 0
  let previousBtw: string | undefined
  for (const [i, block] of blocks.entries()) {
    if (block.kind === 'work-duration') boundary = i + 1
    if (block.kind !== 'user') continue
    if (boundary > 0 && (!block.btw || block.btw.conversationId !== previousBtw)) {
      starts.push(boundary)
      boundary = 0
    }
    previousBtw = block.btw?.conversationId
  }
  const groups = new Map<string, number>()
  let group = 0
  for (const [i, block] of blocks.entries()) {
    if (i === starts[group + 1]) group++
    groups.set(block.id, group)
    groups.set(workSectionId(block, block.id), group)
    if (block.kind === 'user' && block.btw) groups.set(`btw-conversation-${block.btw.conversationId}`, group)
  }
  const index = { starts, groups }
  indexes.set(blocks, index)
  return index
}

/** 翻页时保留光标另一侧最多两页，确保正在阅读的段仍在新窗口内。 */
export function conversationHistoryWindow(state: ConversationState, location?: HistoryLocation): ConversationHistoryWindow {
  const { starts, groups } = historyIndex(state.blocks)
  const count = starts.length
  let first = Math.max(0, count - WORKS_PER_PAGE)
  let last = count
  if (location?.kind === 'around') {
    const target = groups.get(location.id)
    if (target === undefined) throw new Error('定位的消息已不在当前会话中')
    first = Math.max(0, Math.min(target - Math.floor(WORKS_PER_PAGE / 2), count - WORKS_PER_PAGE))
    last = Math.min(count, first + WORKS_PER_PAGE)
  } else if (location) {
    const boundary = starts.indexOf(location.cursor)
    if (boundary < 0) throw new Error('历史窗口已变化，请重新定位')
    first = Math.max(0, boundary - (location.kind === 'older' ? WORKS_PER_PAGE : 2 * WORKS_PER_PAGE))
    last = Math.min(count, boundary + (location.kind === 'older' ? 2 * WORKS_PER_PAGE : WORKS_PER_PAGE))
  }
  const start = starts[first]!
  const end = starts[last] ?? state.blocks.length
  return {
    before: start || null,
    after: end < state.blocks.length ? end : null,
    view: conversationSnapshotRange(state, start, end),
  }
}

/** 定位轨只在选中会话时传一次；翻页不携带窗口以外的正文或预览。 */
export function conversationHistorySnapshot(state: ConversationState, anchor?: string): ConversationHistorySnapshot {
  const tail = conversationHistoryWindow(state)
  return {
    ...tail,
    earlierEntries: conversationNavigationEntries(conversationSections(state.blocks.slice(0, tail.before ?? 0))),
    reading: anchor ? conversationReadingWindow(state, anchor) : undefined,
  }
}

export function conversationReadingWindow(state: ConversationState, anchor: string): ConversationHistoryWindow | undefined {
  const { starts, groups } = historyIndex(state.blocks)
  const group = groups.get(anchor)
  return group !== undefined && group < starts.length - WORKS_PER_PAGE
    ? conversationHistoryWindow(state, { kind: 'around', id: anchor }) : undefined
}

/** 一直停留在同一会话时，留一页余量，避免每轮结束都重组尾部。 */
export function liveTailNeedsTrimming(state: ConversationState): boolean {
  return state.blocks.at(-1)?.kind === 'work-duration' && historyIndex(state.blocks).starts.length > 2 * WORKS_PER_PAGE
}
