import type { ModelMessage } from 'ai'
import { safeBoundaryBefore } from './compact-boundary.ts'
import { estimateMessagesTokens } from './tokens.ts'
import { latestUserTurnIndex, userTurn } from './user-turn.ts'

export const COMPACT_PTL_MAX_RETRIES = 3

/** 优先移除旧正式轮次；单个超长任务可退到完整模型步骤，始终保护原始请求与最后步骤。 */
export function trimSummaryInput(messages: ModelMessage[], tokenGap?: number): ModelMessage[] | null {
  const formalBoundaries = messages.flatMap((message, index) =>
    index > 0 && userTurn(message)?.startsTurn && safeBoundaryBefore(messages, index) === index ? [index] : [])
  const target = tokenGap === undefined ? Math.ceil(estimateMessagesTokens(messages) * 0.2)
    : tokenGap + Math.max(256, Math.ceil(tokenGap * 0.05))
  for (const boundary of formalBoundaries) {
    if (estimateMessagesTokens(messages.slice(0, boundary)) >= target) return messages.slice(boundary)
  }
  const rootIndex = latestUserTurnIndex(messages)
  const root = messages[rootIndex]
  let candidate: ModelMessage[] | null = null
  const total = estimateMessagesTokens(messages)
  for (let index = 1; index < messages.length; index++) {
    if (messages[index]!.role !== 'assistant' || safeBoundaryBefore(messages, index) !== index) continue
    const remaining = [...(root && rootIndex < index ? [root] : []), ...messages.slice(index)]
    const removed = total - estimateMessagesTokens(remaining)
    if (removed <= 0) continue
    candidate = remaining
    if (removed >= target) return remaining
  }
  const last = formalBoundaries.at(-1)
  return candidate ?? (last === undefined ? null : messages.slice(last))
}
