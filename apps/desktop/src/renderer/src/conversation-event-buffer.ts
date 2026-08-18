import {
  coalesceAdjacentCoreEvent,
  type CoreEvent,
} from '@whycode/core/events'

export interface BufferedConversationEvent {
  event: CoreEvent
  occurredAt?: string
}

interface ConversationEventBufferOptions {
  flush: (events: readonly BufferedConversationEvent[]) => void
  requestFrame: (callback: () => void) => number
  cancelFrame: (id: number) => void
}

const MAX_PENDING_EVENTS = 128

/** 高频追加流最多等待一帧；所有语义边界会连同此前片段立即、保序落地。 */
export class ConversationEventBuffer {
  private pending: BufferedConversationEvent[] = []
  private frameId: number | null = null
  private readonly options: ConversationEventBufferOptions

  constructor(options: ConversationEventBufferOptions) {
    this.options = options
  }

  push(event: CoreEvent, occurredAt?: string): void {
    this.append({ event, occurredAt })
    if (!isFrameBufferedEvent(event) || this.pending.length >= MAX_PENDING_EVENTS) {
      this.flush()
      return
    }
    if (this.frameId !== null) return
    this.frameId = this.options.requestFrame(() => {
      this.frameId = null
      this.flushPending()
    })
  }

  clear(): void {
    if (this.frameId !== null) this.options.cancelFrame(this.frameId)
    this.frameId = null
    this.pending = []
  }

  private append(next: BufferedConversationEvent): void {
    const previous = this.pending.at(-1)
    if (previous) {
      const event = coalesceAdjacentCoreEvent(previous.event, next.event)
      if (event) {
        this.pending[this.pending.length - 1] = {
          event,
          occurredAt: next.occurredAt ?? previous.occurredAt,
        }
        return
      }
    }
    this.pending.push(next)
  }

  private flush(): void {
    if (this.frameId !== null) this.options.cancelFrame(this.frameId)
    this.frameId = null
    this.flushPending()
  }

  private flushPending(): void {
    if (this.pending.length === 0) return
    const events = this.pending
    this.pending = []
    this.options.flush(events)
  }
}

function isFrameBufferedEvent(event: CoreEvent): boolean {
  return event.type === 'text-delta'
    || event.type === 'thinking-delta'
    || event.type === 'tool-progress'
    || (event.type === 'peer-event' && event.event.type === 'text-delta')
}
