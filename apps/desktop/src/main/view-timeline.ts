import {
  pushCoalescedViewEvent,
  toViewEvent,
  type CoreEvent,
  type ViewEvent,
} from '@whycode/core'

export interface ViewEventWriter {
  recordViewEvents(events: ViewEvent[]): Promise<void>
}

type Channel = 'Main' | 'B' | 'C'

interface PendingStep {
  writer: ViewEventWriter | null
  events: ViewEvent[]
}

const STEP_SCOPED_EVENTS = new Set<CoreEvent['type']>([
  'text-delta',
  'thinking-delta',
  'thinking-end',
  'tool-start',
  'tool-progress',
  'tool-end',
  'checkpoint-created',
  'checkpoint-disabled',
  'task-plan-updated',
  'user-question',
])

/**
 * 把模型流分成 Main/B/C 三条 step 缓冲：只有 step-committed 才写入用户可见时间线，
 * step-discarded（取消、urgent、异常）直接丢弃。turn 起点等已稳定事件立即写入。
 */
export class ViewTimeline {
  private readonly onWriteError: (error: unknown) => void
  private pending: Record<Channel, PendingStep> = {
    Main: { writer: null, events: [] },
    B: { writer: null, events: [] },
    C: { writer: null, events: [] },
  }

  constructor(onWriteError: (error: unknown) => void) {
    this.onWriteError = onWriteError
  }

  capture(writer: ViewEventWriter | null, event: CoreEvent): void {
    if (!writer) return
    if (event.type === 'peer-event') {
      const channel = event.agentId
      if (event.event.type === 'step-committed') return this.commit(channel)
      if (event.event.type === 'step-discarded') return this.discard(channel)
      const viewEvent = toViewEvent(event)
      if (viewEvent) this.buffer(channel, writer, viewEvent)
      return
    }
    if (event.type === 'step-committed') return this.commit('Main')
    if (event.type === 'step-discarded') return this.discard('Main')
    if (event.type === 'agent-status' && event.status === 'idle') {
      this.discardAll()
      return
    }
    const viewEvent = toViewEvent(event)
    if (!viewEvent) return
    if (STEP_SCOPED_EVENTS.has(event.type)) {
      this.buffer('Main', writer, viewEvent)
    } else {
      this.write(writer, [viewEvent])
    }
  }

  discardAll(): void {
    for (const channel of ['Main', 'B', 'C'] as const) this.discard(channel)
  }

  private buffer(channel: Channel, writer: ViewEventWriter, event: ViewEvent): void {
    const pending = this.pending[channel]
    if (pending.writer && pending.writer !== writer) pending.events = []
    pending.writer = writer
    pushCoalescedViewEvent(pending.events, event)
  }

  private commit(channel: Channel): void {
    const pending = this.pending[channel]
    if (pending.writer && pending.events.length > 0) {
      this.write(pending.writer, pending.events.splice(0))
    }
    pending.writer = null
  }

  private discard(channel: Channel): void {
    this.pending[channel] = { writer: null, events: [] }
  }

  private write(writer: ViewEventWriter, events: ViewEvent[]): void {
    void writer.recordViewEvents(events).catch(this.onWriteError)
  }
}
