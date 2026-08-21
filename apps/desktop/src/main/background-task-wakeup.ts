import type { CommandTaskTerminalNotification } from '@whycode/core'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import type { UserMessageReservation } from './user-message-routing.ts'
import {
  SessionNotificationWakeQueue,
  type SessionWakeRuntimeResolution,
} from './session-notification-wakeup.ts'

export type BackgroundTaskRuntimeResolution = SessionWakeRuntimeResolution

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
  private readonly queue: SessionNotificationWakeQueue<CommandTaskTerminalNotification>

  constructor(options: BackgroundTaskWakeQueueOptions) {
    this.queue = new SessionNotificationWakeQueue({
      key: notificationKey,
      sessionId: (notification) => notification.task.sessionId,
      resolveRuntime: options.resolveRuntime,
      reserveWorkStart: options.reserveWorkStart,
      deliveryBlocked: options.deliveryBlocked,
      deliver: options.deliver,
      onError: options.onError,
    })
  }

  enqueue(notification: CommandTaskTerminalNotification): void {
    this.queue.enqueue(notification)
  }

  discardSession(sessionId: string): void {
    this.queue.discardSession(sessionId)
  }

  /** 由任务入队、任一运行体转空闲或连接设置写入结束触发；每次只做一轮事件驱动尝试。 */
  nudge(): Promise<void> {
    return this.queue.nudge()
  }

  /** 应用退出时停止接收新通知，并等待正在进行的恢复/路由尝试离开临界区。 */
  async close(): Promise<void> {
    await this.queue.close()
  }
}

function notificationKey(notification: CommandTaskTerminalNotification): string {
  return `${notification.task.sessionId}:${notification.task.id}`
}
