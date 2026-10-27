import type { CoreEvent } from '@whycode/core/events'

/**
 * 未选中且未在恢复的运行时只需推动会话列表的生命周期状态。其完整时间线已有 Main
 * 权威快照；继续把 token、工具进度等高频事件投影到不可见页面只会制造内存压力。
 */
export function shouldDeliverRuntimeEvent(
  event: CoreEvent,
  runtime: { sessionId: string | null },
  selected: { sessionId: string | null } | null,
  resumingSessionId: string | null,
): boolean {
  // 恢复请求先接通实时流，再读取快照；否则快照游标到提交选择之间会丢失正文。
  if (runtime === selected || (runtime.sessionId !== null && runtime.sessionId === resumingSessionId)) return true
  switch (event.type) {
    case 'work-started':
    case 'work-discarded':
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
