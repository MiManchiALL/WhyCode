import { setImmediate } from 'node:timers/promises'
import type { ViewEvent } from '@whycode/core'
import {
  applyViewEvent,
  createConversationState,
  type Block,
  type ConversationState,
} from '../shared/conversation-state.ts'
import { conversationSections } from '../shared/conversation-sections.ts'
import { conversationNavigationEntries } from '../shared/conversation-navigation.ts'
import type { ConversationHistoryWindow } from '../shared/conversation-history.ts'

const HISTORY_WORKS_PER_PAGE = 20
const HISTORY_JUMP_WORKS_PER_PAGE = 100

/** 与 Renderer 共用唯一事件投影；仅补算新提交的事件，随运行时一起释放。 */
export class ConversationHistoryProjection {
  private state = createConversationState()
  private count = 0
  private projecting: Promise<void> | null = null

  async update(events: readonly ViewEvent[], timestamps: readonly string[]): Promise<ConversationState> {
    while (this.count < events.length) {
      if (this.projecting) {
        await this.projecting
        continue
      }
      this.projecting = this.project(events, timestamps)
      try {
        await this.projecting
      } finally {
        this.projecting = null
      }
    }
    return this.state
  }

  get eventCount(): number { return this.count }

  private async project(events: readonly ViewEvent[], timestamps: readonly string[]): Promise<void> {
    let yieldedAt = performance.now()
    while (this.count < events.length) {
      this.state = applyViewEvent(this.state, events[this.count]!, timestamps[this.count])
      this.count++
      // 冷历史投影让出宿主事件循环，新的会话点击与已加载运行时不必等它结束。
      if (performance.now() - yieldedAt >= 8) {
        await setImmediate()
        yieldedAt = performance.now()
      }
    }
  }
}

/** 从完整投影取一段完整工作；不为未加载的历史建立占位高度。 */
export function conversationHistoryWindow(
  state: ConversationState,
  options: { before?: number; targetId?: string; from?: string } = {},
): ConversationHistoryWindow {
  const { blocks } = state
  // 用户只能改写已加载的尾部；前缀块数不会因边界消息被回滚删除而失效。
  const end = Math.min(options.before ?? blocks.length, blocks.length)
  if (!Number.isInteger(end) || end < 0) throw new Error('无效的历史位置')
  const starts = historyWorkStarts(blocks).filter((index) => index < end)
  const size = options.targetId ? HISTORY_JUMP_WORKS_PER_PAGE : HISTORY_WORKS_PER_PAGE
  let start = starts[Math.max(0, starts.length - size)] ?? 0
  if (options.from) {
    const restored = blocks.findIndex((block) => block.id === options.from)
    if (restored >= 0) start = Math.min(start, workStartAt(starts, restored))
  }
  if (options.targetId) {
    const target = blocks.findIndex((block) => block.id === options.targetId)
    if (target >= start && target < end) start = workStartAt(starts, target)
  }
  const pageBlocks = blocks.slice(start, end)
  const included = new Set(pageBlocks.flatMap((block) => [block.id, `work-${block.id}`]))
  const pendingStep = end === blocks.length && state.pendingStep
    ? { ...state.pendingStep, blocks: state.pendingStep.blocks.slice(start) }
    : null
  const earlierSections = conversationSections(blocks.slice(0, start))
  return {
    before: start > 0 ? start : null,
    earlierEntries: conversationNavigationEntries(earlierSections),
    view: {
      ...state,
      blocks: pageBlocks,
      expanded: [...state.expanded].filter((id) => included.has(id)),
      turnStartBlocks: [...state.turnStartBlocks]
        .filter(([, index]) => index >= start && index < end)
        .map(([id, index]) => [id, index - start]),
      pendingTurnStart: state.pendingTurnStart !== null
        && state.pendingTurnStart >= start && state.pendingTurnStart < end
        ? state.pendingTurnStart - start
        : null,
      pendingStep,
    },
  }
}

function historyWorkStarts(blocks: readonly Block[]): number[] {
  const starts = [0]
  let boundary = 0
  let previousBtw: string | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'work-duration') boundary = index + 1
    if (block.kind !== 'user') continue
    if (boundary > 0 && (!block.btw || block.btw.conversationId !== previousBtw)) {
      starts.push(boundary)
      boundary = 0
    }
    previousBtw = block.btw?.conversationId
  }
  return starts
}

function workStartAt(starts: readonly number[], index: number): number {
  return starts.findLast((start) => start <= index) ?? 0
}
