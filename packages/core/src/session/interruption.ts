import type { ModelMessage } from 'ai'

export type TurnInterruptionReason =
  | 'user-cancel'
  | 'process-interruption'
  | 'consensus-failure'

const TURN_ABORTED_MARKER_PREFIX = '<whycode-turn-aborted version="1" reason="'
const TURN_ABORTED_CONSUMED_MARKER = '<whycode-turn-aborted-consumed version="1">'

/** 仅进入模型上下文，不进入用户可见时间线。 */
export function createTurnAbortedMessage(
  reason: TurnInterruptionReason = 'user-cancel',
): ModelMessage {
  const cause = reason === 'user-cancel'
    ? '上一回合已被用户主动停止。'
    : reason === 'process-interruption'
      ? '上一回合在完成前因应用关闭或进程中断而结束。'
      : '上一协商任务在形成可执行结果前失败。'
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      `${TURN_ABORTED_MARKER_PREFIX}${reason}">`,
      `${cause}该回合中尚未得到完整回应的旧用户消息只作为历史背景，不是当前待办。`,
      '不要自动继续旧任务，也不要根据旧消息修改任务计划；只处理此标记之后最新的真实用户消息。',
      '只有最新消息明确要求继续、调整或取消旧任务时，才重新处理原计划。',
      '已中止的工具可能只执行了一部分；若之后恢复相关工作，先检查实际状态。',
      '</whycode-turn-aborted>',
      '</system-reminder>',
    ].join('\n'),
  }
}

export function isTurnAbortedMessage(message: ModelMessage): boolean {
  if (message.role !== 'user') return false
  const content = messageText(message).trim()
  return content.startsWith(`<system-reminder>\n${TURN_ABORTED_MARKER_PREFIX}`)
    && content.endsWith('</whycode-turn-aborted>\n</system-reminder>')
}

/** 最近一次中断在完整历史中的位置。 */
export function findLatestTurnAbortedIndex(messages: ModelMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isTurnAbortedMessage(messages[index]!)) return index
  }
  return null
}

/** 本轮首个稳定 step 已确认最新意图；之后可解除最近中断的压缩/工具门控。 */
export function createTurnAbortedConsumedMessage(): ModelMessage {
  return {
    role: 'user',
    content: [
      '<system-reminder>',
      TURN_ABORTED_CONSUMED_MARKER,
      '本轮最新用户意图已经由首个稳定步骤确认；此标记只解除后续压缩和回合门控，不表示当前请求已经完成。',
      '继续遵循本轮最新真实用户消息：若它已明确恢复旧任务，无需再次确认并继续执行；若它是新问题，旧任务仍只作背景。',
      '未来回合仍不得脱离新的明确恢复消息，把此前被中断的请求自动变成待办。',
      '</whycode-turn-aborted-consumed>',
      '</system-reminder>',
    ].join('\n'),
  }
}

/**
 * 返回尚未被一个稳定用户回合显式消费的最近中断边界。
 * 压缩必须保留它以及其后的真实用户消息，否则旧未答请求会重新变成活动指令。
 */
export function findPendingTurnAbortedIndex(messages: ModelMessage[]): number | null {
  const markerIndex = findLatestTurnAbortedIndex(messages)
  if (markerIndex === null) return null
  return messages.slice(markerIndex + 1).some(isTurnAbortedConsumedMessage)
    ? null
    : markerIndex
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

function isTurnAbortedConsumedMessage(message: ModelMessage): boolean {
  if (message.role !== 'user') return false
  const content = messageText(message).trim()
  return content.startsWith(`<system-reminder>\n${TURN_ABORTED_CONSUMED_MARKER}\n`)
    && content.endsWith('</whycode-turn-aborted-consumed>\n</system-reminder>')
}
