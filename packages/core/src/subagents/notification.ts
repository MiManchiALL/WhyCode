import type { ModelMessage } from 'ai'
import { unicodeSafePrefix } from '../text.ts'
import { estimateMessageTokens } from '../context/tokens.ts'
import type { SubagentOutcome, SubagentSettlementNotification } from './types.ts'

export const MAX_SUBAGENT_RESULT_CHARS = 120_000
const TRUNCATED_RESULT_NOTE = '\n\n[内容过长，后文已截断。]'
export const SUBAGENT_SETTLEMENT_OPEN = '<subagent-settlement version="2">'
export const SUBAGENT_SETTLEMENT_CLOSE = '</subagent-settlement>'

export function createSubagentSettlementMessage(
  notification: SubagentSettlementNotification,
  tokenBudget = Number.POSITIVE_INFINITY,
): ModelMessage {
  let limit = Math.min(notification.resultText.length, MAX_SUBAGENT_RESULT_CHARS)
  let message = settlementMessage(notification, limit)
  if (estimateMessageTokens(message) <= tokenBudget) return message
  // 按最终序列化消息计量，包含 JSON 转义和协议开销；正文只在交付边界裁剪。
  let low = 0
  let high = limit
  while (low < high) {
    limit = Math.ceil((low + high) / 2)
    if (estimateMessageTokens(settlementMessage(notification, limit)) <= tokenBudget) low = limit
    else high = limit - 1
  }
  message = settlementMessage(notification, low)
  if (estimateMessageTokens(message) > tokenBudget) throw new Error('当前上下文没有容纳子代理结果的空间')
  return message
}

export function boundedSubagentResult(text: string, outcome: SubagentOutcome): string {
  return truncateResult(text, MAX_SUBAGENT_RESULT_CHARS, outcome)
}

function truncateResult(text: string, limit: number, outcome: SubagentOutcome): string {
  if (text.length <= limit) return text
  const note = outcome === 'completed' ? TRUNCATED_RESULT_NOTE : '\n\n[内容过长，后文已截断；结果尚未完成。]'
  return unicodeSafePrefix(text, Math.max(0, limit - note.length)) + note
}

function settlementMessage(notification: SubagentSettlementNotification, limit: number): ModelMessage {
  const payload = {
    subagent_id: notification.subagentId,
    description: notification.description,
    outcome: notification.outcome,
    result: truncateResult(notification.resultText, limit, notification.outcome),
  }
  return {
    role: 'user',
    content: [
      SUBAGENT_SETTLEMENT_OPEN,
      serializePayload(payload),
      '这是子代理交付结果，不是用户输入；后续交互使用 subagent_id。',
      SUBAGENT_SETTLEMENT_CLOSE,
    ].join('\n'),
  }
}

export function isSubagentSettlementText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith(`${SUBAGENT_SETTLEMENT_OPEN}\n`)
    && trimmed.endsWith(`\n${SUBAGENT_SETTLEMENT_CLOSE}`)
}

function serializePayload(payload: object): string {
  return JSON.stringify(payload)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}
