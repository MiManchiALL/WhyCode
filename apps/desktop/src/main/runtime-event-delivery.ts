import type { CoreEvent } from '@whycode/core/events'

/**
 * 未选中的运行时只需推动会话列表的生命周期状态。其完整时间线已有 Main
 * 权威快照；继续把 token、工具进度等高频事件投影到不可见页面只会制造内存压力。
 */
export function isBackgroundRuntimeLifecycleEvent(event: CoreEvent): boolean {
  switch (event.type) {
    case 'work-started':
    case 'turn-start':
    case 'work-finished':
    case 'turn-end':
      return true
    case 'agent-status':
      return event.status === 'idle' || event.status === 'error'
    default:
      return false
  }
}
