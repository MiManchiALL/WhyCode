import type { ModelMessage } from 'ai'
import { unicodeSafePrefix } from '../text.ts'
import type { SubagentSettlementNotification } from './types.ts'

const MAX_RESULT_CHARS = 48_000
export const SUBAGENT_SETTLEMENT_OPEN = '<subagent-settlement version="1">'
export const SUBAGENT_SETTLEMENT_CLOSE = '</subagent-settlement>'

export function createSubagentSettlementMessage(
  notification: SubagentSettlementNotification,
): ModelMessage {
  const payload = {
    parent_turn_id: notification.parentTurnId,
    subagent_id: notification.subagentId,
    activation_id: notification.activationId,
    name: notification.name,
    outcome: notification.outcome,
    result: unicodeSafePrefix(notification.resultText, MAX_RESULT_CHARS),
    result_truncated: notification.resultText.length > MAX_RESULT_CHARS,
  }
  return {
    role: 'user',
    content: [
      SUBAGENT_SETTLEMENT_OPEN,
      serializePayload(payload),
      '这是 WhyCode 生成的子代理终态，不是用户输入。请结合结果继续父任务；需要补充时可用同一 subagent_id 继续该子代理。',
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
