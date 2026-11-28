import { setImmediate } from 'node:timers/promises'
import type { ViewEvent } from '@whycode/core'
import {
  applyViewEvent,
  createConversationState,
  type ConversationState,
} from '../shared/conversation-state.ts'

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
