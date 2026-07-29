import {
  isStepScopedCoreEvent,
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
  order: number[]
}

/**
 * 把模型流分成 Main/B/C 三条 step 缓冲：只有 step-committed 才写入用户可见时间线，
 * step-discarded（取消、urgent、异常）直接丢弃。turn 起点等已稳定事件立即写入。
 */
export class ViewTimeline {
  private readonly onWriteError: (error: unknown) => void
  private captureSequence = 0
  private readonly pendingWrites = new Set<Promise<void>>()
  private pending: Record<Channel, PendingStep> = {
    Main: { writer: null, events: [], order: [] },
    B: { writer: null, events: [], order: [] },
    C: { writer: null, events: [], order: [] },
  }

  constructor(onWriteError: (error: unknown) => void) {
    this.onWriteError = onWriteError
  }

  capture(writer: ViewEventWriter | null, event: CoreEvent): void {
    if (!writer) return
    if (event.type === 'peer-event') {
      const channel = event.agentId
      if (event.event.type === 'step-committed') return this.commit(channel)
      if (event.event.type === 'step-output-retained') return this.retainOutput(channel)
      if (event.event.type === 'step-discarded') return this.discard(channel)
      const viewEvent = toViewEvent(event)
      if (viewEvent) this.buffer(channel, writer, viewEvent)
      return
    }
    if (event.type === 'step-committed') return this.commit('Main')
    if (event.type === 'step-output-retained') return this.retainOutput('Main')
    if (event.type === 'step-discarded') return this.discard('Main')
    if (event.type === 'agent-status' && event.status === 'idle') {
      this.discardAll()
      return
    }
    const viewEvent = toViewEvent(event)
    if (!viewEvent) return
    if (isStepScopedCoreEvent(event)) {
      this.buffer('Main', writer, viewEvent)
    } else {
      this.write(writer, [viewEvent])
    }
  }

  discardAll(): void {
    for (const channel of ['Main', 'B', 'C'] as const) this.discard(channel)
  }

  /** 等待已提交的可见事件写稳；运行中的 step 仍只作为瞬时快照返回。 */
  async snapshot(writer: ViewEventWriter & { initialViewEvents: readonly ViewEvent[] }):
  Promise<ViewEvent[]> {
    return (await this.snapshotAt(writer, () => undefined)).events
  }

  async flush(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.all([...this.pendingWrites])
    }
  }

  /**
   * 在同一同步边界取得时间线与宿主事件游标。游标必须在事件副本完成后读取，
   * 否则两者之间到达的事件可能既不在快照中，又被 Renderer 当成旧事件丢弃。
   */
  async snapshotAt<T>(
    writer: ViewEventWriter & { initialViewEvents: readonly ViewEvent[] },
    readBoundary: () => T,
  ): Promise<{ events: ViewEvent[]; boundary: T }> {
    // 等待期间可能又提交新的稳定事件；必须排空到同一同步边界，事件序号才能
    // 与快照形成无缺口的接续点。
    await this.flush()
    const pending = (['Main', 'B', 'C'] as const)
      .flatMap((channel) => {
        const step = this.pending[channel]
        if (step.writer !== writer) return []
        return step.events.map((event, index) => ({
          event,
          order: step.order[index] ?? Number.MAX_SAFE_INTEGER,
        }))
      })
      .sort((left, right) => left.order - right.order)
      .map(({ event }) => structuredClone(event))
    const events = [
      ...writer.initialViewEvents.map((event) => structuredClone(event)),
      ...pending,
    ]
    return { events, boundary: readBoundary() }
  }

  private buffer(channel: Channel, writer: ViewEventWriter, event: ViewEvent): void {
    const pending = this.pending[channel]
    if (pending.writer && pending.writer !== writer) {
      pending.events = []
      pending.order = []
    }
    pending.writer = writer
    const previousLength = pending.events.length
    pushCoalescedViewEvent(pending.events, event)
    if (pending.events.length > previousLength) {
      pending.order.push(++this.captureSequence)
    }
  }

  private commit(channel: Channel): void {
    const pending = this.pending[channel]
    if (pending.writer && pending.events.length > 0) {
      this.write(pending.writer, pending.events.splice(0))
    }
    pending.writer = null
    pending.order = []
  }

  private retainOutput(channel: Channel): void {
    const pending = this.pending[channel]
    const output = pending.events.filter((event) =>
      event.type === 'core-event'
      && (
        event.event.type === 'text-delta'
        || (event.event.type === 'peer-event' && event.event.event.type === 'text-delta')
      ))
    if (pending.writer && output.length > 0) this.write(pending.writer, output)
    this.discard(channel)
  }

  private discard(channel: Channel): void {
    this.pending[channel] = { writer: null, events: [], order: [] }
  }

  private write(writer: ViewEventWriter, events: ViewEvent[]): void {
    let pending: Promise<void>
    pending = writer.recordViewEvents(events)
      .catch((error) => this.onWriteError(error))
      .finally(() => this.pendingWrites.delete(pending))
    this.pendingWrites.add(pending)
  }
}
