import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'

export type SessionWakeRuntimeResolution =
  | { kind: 'ready'; runtime: DesktopSessionRuntime }
  | { kind: 'defer' }
  | { kind: 'drop' }

export interface SessionNotificationWakeQueueOptions<Notification> {
  key: (notification: Notification) => string
  sessionId: (notification: Notification) => string
  clone?: (notification: Notification) => Notification
  resolveRuntime: (sessionId: string) => Promise<SessionWakeRuntimeResolution>
  reserveWorkStart: (runtime: DesktopSessionRuntime) => UserMessageReservation | null
  deliveryBlocked: (runtime: DesktopSessionRuntime) => boolean
  deliver: (runtime: DesktopSessionRuntime, notification: Notification) => void
  onDrop?: (notification: Notification) => void | Promise<void>
  onError?: (error: unknown) => void
}

/**
 * 宿主内部终态的事件驱动交付队列。它只保存待交付的小型通知，不持有运行体、
 * transcript 或日志；恢复会话和用户输入仍通过同一并发预留边界。
 */
export class SessionNotificationWakeQueue<Notification> {
  private readonly options: SessionNotificationWakeQueueOptions<Notification>
  private readonly pending = new Map<string, Notification>()
  private tail: Promise<void> = Promise.resolve()
  private readonly closeSignal: Promise<void>
  private resolveCloseSignal!: () => void
  private closed = false

  constructor(options: SessionNotificationWakeQueueOptions<Notification>) {
    this.options = options
    this.closeSignal = new Promise((resolve) => { this.resolveCloseSignal = resolve })
  }

  enqueue(notification: Notification): void {
    if (this.closed) return
    const clone = this.options.clone?.(notification) ?? structuredClone(notification)
    this.pending.set(this.options.key(clone), clone)
    void this.nudge()
  }

  discardSession(sessionId: string): void {
    for (const [key, notification] of this.pending) {
      if (this.options.sessionId(notification) === sessionId) this.pending.delete(key)
    }
  }

  nudge(): Promise<void> {
    if (this.closed) return this.tail
    const run = this.tail.then(() => this.drainOnce())
    this.tail = run.catch((error) => this.report(error))
    return this.tail
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.pending.clear()
      this.resolveCloseSignal()
    }
    await this.tail
  }

  private async drainOnce(): Promise<void> {
    for (const [key, notification] of [...this.pending]) {
      if (this.closed) return
      let resolution: SessionWakeRuntimeResolution
      try {
        resolution = await this.options.resolveRuntime(this.options.sessionId(notification))
      } catch (error) {
        this.report(error)
        continue
      }
      if (this.closed) return
      if (resolution.kind === 'drop') {
        this.pending.delete(key)
        await this.options.onDrop?.(notification)
        continue
      }
      if (resolution.kind === 'defer') continue

      const { runtime } = resolution
      if (this.options.deliveryBlocked(runtime)) continue
      const reservation = this.options.reserveWorkStart(runtime)
      if (!reservation) continue
      try {
        await Promise.race([reservation.ready, this.closeSignal])
        if (this.closed || this.options.deliveryBlocked(runtime)) continue
        this.options.deliver(runtime, notification)
        this.pending.delete(key)
      } catch (error) {
        this.report(error)
      } finally {
        reservation.release()
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error)
    } catch {}
  }
}
