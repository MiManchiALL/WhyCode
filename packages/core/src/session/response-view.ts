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
export function responseViewEvents(entry: SessionEntry): ViewEvent[] {
  if (entry.type === 'turn-end') {
    return entry.stopReason === 'completed' ? [{ type: 'turn-completed' }] : []
  }
  if (entry.type === 'view-events') return committedViewBatch(entry.events)
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
  if (entry.assistantText) {
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
