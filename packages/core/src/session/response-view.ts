import type { ModelMessage } from 'ai'
import { btwToolStepEvents } from './btw.ts'
import type { SessionEntry } from './types.ts'
import type { RecordedViewEvent, ViewEvent } from './view-events.ts'

export function committedViewBatch(events: RecordedViewEvent[]): ViewEvent[] {
  const hasToolCalls = events.some(item => item.type === 'core-event' && item.event.type === 'tool-start')
  if (!hasToolCalls && !events.some(item => item.type === 'core-event' && item.event.type === 'text-delta')) {
    return events
  }
  return [...events, { type: 'step-committed', hasToolCalls }]
}

/** Journal 已按模型步骤提交可见事件。展开记录时保留批次和回合边界，不重复落盘。 */
export function responseViewEvents(entry: SessionEntry, messages?: readonly ModelMessage[]): ViewEvent[] {
  if (entry.type === 'turn-end') {
    return entry.stopReason === 'completed' ? [{ type: 'turn-completed' }] : []
  }
  if (entry.type === 'view-events') {
    return committedViewBatch(messages ? restoreTextBlocks(entry.events, messages) : entry.events)
  }
  if (entry.type !== 'btw-response') return []

  const events: ViewEvent[] = []
  for (const step of entry.toolSteps ?? []) {
    for (const event of btwToolStepEvents([step])) events.push({ type: 'core-event', event })
    events.push({ type: 'step-committed', hasToolCalls: true })
  }
  if (entry.reasoningText) {
    events.push({ type: 'core-event', event: { type: 'thinking-delta', text: entry.reasoningText } })
    events.push({ type: 'core-event', event: { type: 'thinking-end', durationMs: entry.reasoningDurationMs } })
  }
  if (Array.isArray(entry.assistantText)) {
    for (const [index, part] of entry.assistantText.entries()) {
      events.push({ type: 'core-event', event: {
        type: 'text-delta', text: part.text, textBlock: index,
      } })
    }
  } else if (entry.assistantText) {
    events.push({ type: 'core-event', event: { type: 'text-delta', text: entry.assistantText } })
  }
  if (entry.outcome === 'completed') {
    events.push({ type: 'step-committed', hasToolCalls: false })
  }
  if (entry.error) {
    events.push({ type: 'core-event', event: { type: 'error', message: entry.error, recoverable: true } })
  }
  events.push({
    type: 'core-event',
    event: {
      type: 'work-finished',
      durationMs: entry.durationMs,
      outcome: entry.outcome,
      ...(entry.error ? { error: entry.error } : {}),
      forkTurnId: null,
      btw: {
        conversationId: entry.conversationId,
        turnIndex: entry.turnIndex,
        continuationAvailable: entry.continuationAvailable,
      },
    },
  })
  return events
}

/** 只在规范正文与可见流逐字一致时恢复边界。隐藏内容、重试和未提交草稿不能补造正文。 */
function restoreTextBlocks(events: RecordedViewEvent[], messages: readonly ModelMessage[]): RecordedViewEvent[] {
  const parts = messages.flatMap(message => {
    if (message.role !== 'assistant') return []
    return typeof message.content === 'string' ? [message.content]
      : message.content.flatMap(part => part.type === 'text' ? [part.text] : [])
  }).filter(Boolean)
  if (parts.length < 2) return events

  const result: RecordedViewEvent[] = []
  let index = 0
  let offset = 0
  for (const item of events) {
    if (item.type !== 'core-event' || item.event.type !== 'text-delta') {
      result.push(item)
      continue
    }
    const text = item.event.text
    let start = 0
    while (start < text.length) {
      const part = parts[index]
      if (part === undefined) return events
      const size = Math.min(text.length - start, part.length - offset)
      const piece = text.slice(start, start + size)
      if (!part.startsWith(piece, offset)) return events
      result.push({ type: 'core-event', event: { type: 'text-delta', text: piece, textBlock: index } })
      start += size
      offset += size
      if (offset === part.length) {
        index++
        offset = 0
      }
    }
  }
  return index === parts.length ? result : events
}
