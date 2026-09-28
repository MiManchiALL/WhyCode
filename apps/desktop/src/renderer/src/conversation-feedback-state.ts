import type { CoreEvent } from '@whycode/core/events'

export interface ConversationFeedback {
  id: number
  tone: 'success' | 'error' | 'info'
  message: string
  floating?: boolean
}

export function conversationEventFeedback(
  event: CoreEvent,
): Omit<ConversationFeedback, 'id'> | null {
  switch (event.type) {
    case 'error': return { tone: 'error', message: event.message }
    case 'checkpoint-disabled': return { tone: 'info', message: `检查点已禁用：${event.reason}` }
    case 'context-compacted': return {
      tone: 'success',
      message: `上下文已压缩（${event.level === 'full' ? '摘要' : '清理'}：${Math.round(event.preTokens / 1000)}k → ${Math.round(event.postTokens / 1000)}k tokens）`,
    }
    case 'checkpoint-restored': return {
      tone: event.ok ? 'success' : 'error',
      message: event.ok
        ? event.scope === 'files-and-chat'
          ? '已回滚该轮对话与相关文件改动。'
          : '文件已回滚，对话已保留。'
        : `回滚失败：${event.error ?? '当前检查点无法恢复'}`,
    }
    case 'consensus-skipped': return {
      tone: 'info',
      message: event.reason === 'pdf-input'
        ? '本轮含 PDF，仅由 Main 读取；B/C 未读取原文，已跳过协商。'
        : '本轮含图片，仅由当前视觉模型处理；B/C 未读取图片，已跳过协商。',
    }
    case 'negotiation-started': return { tone: 'info', message: 'B/C 正在独立评审。' }
    case 'round-started': return { tone: 'info', message: `进入第 ${event.round} 轮协商。` }
    case 'execution-started': return { tone: 'info', message: 'Main 开始执行。' }
    case 'negotiation-decided': return {
      tone: 'info', message: `协商决定：${event.reason}`,
    }
    default: return null
  }
}

export type ConversationFeedbackPhase = 'visible' | 'held' | 'exiting'

export function holdConversationFeedback(
  phase: ConversationFeedbackPhase,
): ConversationFeedbackPhase {
  return phase === 'visible' ? 'held' : phase
}

export function expireConversationFeedback(
  phase: ConversationFeedbackPhase,
): ConversationFeedbackPhase {
  return phase === 'visible' ? 'exiting' : phase
}

export function releaseConversationFeedback(
  phase: ConversationFeedbackPhase,
): ConversationFeedbackPhase {
  return phase === 'held' ? 'exiting' : phase
}
