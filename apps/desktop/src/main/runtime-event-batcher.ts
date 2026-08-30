import {
  coalesceAdjacentCoreEvent,
  type CoreEvent,
} from '@whycode/core/events'
import type { RuntimeEventEnvelope } from '../shared/session.ts'

/** 20 Hz 足以保持文字流畅，同时显著降低 Electron 事件端口的原生对象 churn。 */
export const RUNTIME_EVENT_BATCH_DELAY_MS = 50
export const RUNTIME_EVENT_BATCH_MAX_INPUTS = 128

type CancelScheduledFlush = () => void

export interface RuntimeEventBatcherOptions {
  publish: (events: readonly RuntimeEventEnvelope[]) => void
  schedule?: (callback: () => void, delayMs: number) => CancelScheduledFlush
  delayMs?: number
  maxPendingInputs?: number
}

function scheduleTimeout(callback: () => void, delayMs: number): CancelScheduledFlush {
  const timeout = setTimeout(callback, delayMs)
  timeout.unref()
  return () => clearTimeout(timeout)
}

/**
 * 主进程中的高频事件闸门。流式增量在短窗口内按语义合并；任何结构事件
 * 都会连同此前增量立即、保序发出，避免每个 token 单独跨进程传输。
 */
export class RuntimeEventBatcher {
  private readonly options: Required<Pick<
    RuntimeEventBatcherOptions,
    'publish' | 'schedule' | 'delayMs' | 'maxPendingInputs'
  >>
  private pending: RuntimeEventEnvelope[] = []
  private pendingInputCount = 0
  private cancelScheduledFlush: CancelScheduledFlush | null = null
  private scheduleGeneration = 0

  constructor(options: RuntimeEventBatcherOptions) {
    this.options = {
      publish: options.publish,
      schedule: options.schedule ?? scheduleTimeout,
      delayMs: options.delayMs ?? RUNTIME_EVENT_BATCH_DELAY_MS,
      maxPendingInputs: options.maxPendingInputs ?? RUNTIME_EVENT_BATCH_MAX_INPUTS,
    }
  }

  push(envelope: RuntimeEventEnvelope): void {
    this.pendingInputCount++
    this.append(envelope)
    if (
      !isFrameBufferedRuntimeEvent(envelope.event)
      || this.pendingInputCount >= this.options.maxPendingInputs
    ) {
      this.flush()
      return
    }
    this.scheduleFlush()
  }

  /** 同步排空，用于结构事件、快照游标和应用退出边界。 */
  flush(): void {
    this.cancelFlush()
    this.flushPending()
  }

  private append(next: RuntimeEventEnvelope): void {
    const previous = this.pending.at(-1)
    if (
      previous
      && previous.runtimeId === next.runtimeId
      && previous.sessionId === next.sessionId
    ) {
      const event = coalesceAdjacentCoreEvent(previous.event, next.event)
      if (event) {
        this.pending[this.pending.length - 1] = { ...next, event }
        return
      }
    }
    this.pending.push(next)
  }

  private scheduleFlush(): void {
    if (this.cancelScheduledFlush) return
    const generation = ++this.scheduleGeneration
    this.cancelScheduledFlush = this.options.schedule(() => {
      if (generation !== this.scheduleGeneration) return
      this.cancelScheduledFlush = null
      this.flushPending()
    }, this.options.delayMs)
  }

  private cancelFlush(): void {
    const cancel = this.cancelScheduledFlush
    if (!cancel) return
    this.cancelScheduledFlush = null
    this.scheduleGeneration++
    cancel()
  }

  private flushPending(): void {
    if (this.pending.length === 0) return
    const pending = this.pending
    this.pending = []
    this.pendingInputCount = 0
    this.options.publish(pending)
  }
}

function isFrameBufferedRuntimeEvent(event: CoreEvent): boolean {
  return event.type === 'text-delta'
    || event.type === 'thinking-delta'
    || event.type === 'tool-progress'
    || (event.type === 'peer-event' && event.event.type === 'text-delta')
}
