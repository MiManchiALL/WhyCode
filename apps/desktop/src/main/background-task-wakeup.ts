import type { CommandTaskTerminalNotification } from '@whycode/core'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'

export type BackgroundTaskRuntimeResolution =
  | { kind: 'ready'; runtime: DesktopSessionRuntime }
  | { kind: 'defer' }
  | { kind: 'drop' }

export interface BackgroundTaskWakeQueueOptions {
  resolveRuntime: (sessionId: string) => Promise<BackgroundTaskRuntimeResolution>
  reserveWorkStart: (runtime: DesktopSessionRuntime) => UserMessageReservation | null
  deliveryBlocked: (runtime: DesktopSessionRuntime) => boolean
  deliver: (
    runtime: DesktopSessionRuntime,
    notification: CommandTaskTerminalNotification,
  ) => void
  onError?: (error: unknown) => void
}

/**
 * Claude Code 式 task-notification 队列：进程终态只入队一次，宿主在会话可运行且
 * 全局有名额时交给 Agent；不轮询、不切换当前会话，也不建立第二份对话状态。
 */
export class BackgroundTaskWakeQueue {
  private readonly pending = new Map<string, CommandTaskTerminalNotification>()
  private tail: Promise<void> = Promise.resolve()
  private readonly options: BackgroundTaskWakeQueueOptions
  private readonly closeSignal: Promise<void>
  private resolveCloseSignal!: () => void
  private closed = false

  constructor(options: BackgroundTaskWakeQueueOptions) {
    this.options = options
    this.closeSignal = new Promise((resolve) => { this.resolveCloseSignal = resolve })
  }

  enqueue(notification: CommandTaskTerminalNotification): void {
    if (this.closed) return
    this.pending.set(notificationKey(notification), structuredClone(notification))
    void this.nudge()
  }

  discardSession(sessionId: string): void {
    for (const [key, notification] of this.pending) {
      if (notification.task.sessionId === sessionId) this.pending.delete(key)
    }
  }

  /** 由任务入队、任一运行体转空闲或连接设置写入结束触发；每次只做一轮事件驱动尝试。 */
  nudge(): Promise<void> {
    if (this.closed) return this.tail
    const run = this.tail.then(() => this.drainOnce())
    this.tail = run.catch((error) => this.report(error))
    return this.tail
  }

  /** 应用退出时停止接收新通知，并等待正在进行的恢复/路由尝试离开临界区。 */
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
      let resolution: BackgroundTaskRuntimeResolution
      try {
        resolution = await this.options.resolveRuntime(notification.task.sessionId)
      } catch (error) {
        this.report(error)
        continue
      }
      if (this.closed) return
      if (resolution.kind === 'drop') {
        this.pending.delete(key)
        continue
      }
      if (resolution.kind === 'defer') continue

      const { runtime } = resolution
      if (this.options.deliveryBlocked(runtime)) continue
      const reservation = this.options.reserveWorkStart(runtime)
      if (!reservation) continue
      try {
        // 输入附件准备可能长期占住前序路由；退出信号必须能释放本队列自己的占位，
        // 否则 before-quit 会在开始关闭运行体之前反向等待用户输入链路。
        await Promise.race([reservation.ready, this.closeSignal])
        if (this.closed || this.options.deliveryBlocked(runtime)) continue
        this.options.deliver(runtime, notification)
        this.pending.delete(key)
      } catch (error) {
        // 终态通知只由命令管理器产生一次；交付异常时保留队列项，等待下一事件重试。
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

function notificationKey(notification: CommandTaskTerminalNotification): string {
  return `${notification.task.sessionId}:${notification.task.id}`
}
