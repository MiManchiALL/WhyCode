import type { ModelMessage } from 'ai'
import { parseCompactSummaryMessage, type CompactSummaryState } from '../prompts/compact.ts'
import { findPendingTurnAbortedIndex } from '../session/interruption.ts'
import { findPendingUserQuestionIndex } from '../tasks/answer-resume.ts'
import { isCommandTaskNotificationText } from '../tools/background-command/notification.ts'
import { isSubagentSettlementText } from '../subagents/notification.ts'
import { modelMessageText } from '../text.ts'
import { estimateMessageTokens } from './tokens.ts'
import { latestUserTurnIndex, userTurn } from './user-turn.ts'

export interface SummarySource {
  previousSummary: string | null
  completedTurnPrefixSummary: string | null
  messages: ModelMessage[]
  userMessage?: ModelMessage
}

export interface CompactionPreparation {
  carriedHistorySummary: string | null
  historySource: SummarySource | null
  turnPrefixSource: SummarySource | null
  turnId: string | null
  pinnedUser: ModelMessage | null
  pendingControls: ModelMessage[]
  tail: ModelMessage[]
}

/** 旧摘要是结构化前缀，不参与尾部切点选择；正式 turn 身份来自宿主输入。 */
export function prepareCompaction(
  messages: ModelMessage[],
  keepRecentTokens: number,
  manual = false,
): CompactionPreparation | null {
  const summary: CompactSummaryState = { historySummary: null, turnPrefixSummary: null, turnId: null }
  const raw = messages.filter(message => {
    if (userTurn(message)) return true
    const parsed = parseCompactSummaryMessage(message)
    if (!parsed) return true
    if (parsed.historySummary) summary.historySummary = parsed.historySummary
    if (parsed.turnPrefixSummary) {
      summary.turnPrefixSummary = parsed.turnPrefixSummary
      summary.turnId = parsed.turnId
    }
    return false
  })
  const protectedStart = earliestProtectedIndex(raw)
  const tailStart = manual ? raw.length
    : safeBoundaryBefore(raw, Math.min(pickBudgetStart(raw, keepRecentTokens), protectedStart ?? raw.length))
  const pendingControls = manual ? [findPendingTurnAbortedIndex(raw), findPendingUserQuestionIndex(raw)]
    .filter((index): index is number => index !== null).map(index => raw[index]!) : []
  const trailingInput = manual ? findTrailingTurnInputBatchStart(raw) : null
  if (trailingInput !== null) pendingControls.push(...raw.slice(trailingInput).filter(message => !userTurn(message)))
  if (!manual && tailStart === 0) return null
  if (manual && raw.length === 0 && !summary.historySummary && !summary.turnPrefixSummary) return null

  const turnStart = latestUserTurnIndex(raw)
  const splitCurrentTurn = !manual && turnStart >= 0 && turnStart < tailStart
  const turnId = splitCurrentTurn ? userTurn(raw[turnStart]!)!.id : null
  const sameTurn = turnId !== null && turnId === summary.turnId
  const historyMessages = raw.slice(0, splitCurrentTurn ? turnStart : tailStart)
    .filter(message => !pendingControls.includes(message))
  const completedPrefix = sameTurn ? null : summary.turnPrefixSummary
  const historySource = historyMessages.length || completedPrefix || (manual && summary.historySummary)
    ? { previousSummary: summary.historySummary, completedTurnPrefixSummary: completedPrefix, messages: historyMessages }
    : null
  const prefixMessages = splitCurrentTurn ? raw.slice(turnStart + 1, tailStart) : []
  // 只移动原始请求而没有逐出工作记录不能降低压力，避免反复生成摘要。
  if (!manual && !historySource && prefixMessages.length === 0) return null
  return {
    carriedHistorySummary: summary.historySummary,
    historySource,
    turnPrefixSource: splitCurrentTurn ? {
      previousSummary: sameTurn ? summary.turnPrefixSummary : null,
      completedTurnPrefixSummary: null,
      userMessage: raw[turnStart]!,
      messages: prefixMessages,
    } : null,
    turnId,
    pinnedUser: splitCurrentTurn ? raw[turnStart]! : null,
    pendingControls,
    tail: raw.slice(tailStart),
  }
}

/** 返回完整调用批次的起点，工具结果不能独自成为摘要或尾部。 */
export function pickBudgetStart(messages: readonly ModelMessage[], keepRecentTokens: number): number {
  if (keepRecentTokens <= 0) return messages.length
  let tokens = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    tokens += estimateMessageTokens(messages[index]!)
    if (tokens < keepRecentTokens) continue
    return safeBoundaryBefore(messages, index)
  }
  return 0
}

export function safeBoundaryBefore(messages: readonly ModelMessage[], index: number): number {
  if (index >= messages.length) return messages.length
  const pending = new Set<string>()
  for (let i = 0; i < index; i++) {
    const message = messages[i]!
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'tool-call') pending.add(part.toolCallId)
      else if (part.type === 'tool-result') pending.delete(part.toolCallId)
    }
  }
  if (pending.size === 0 && messages[index]?.role !== 'tool') return index
  for (let i = index - 1; i >= 0; i--) {
    const message = messages[i]!
    if (message.role === 'assistant' && typeof message.content !== 'string'
      && message.content.some(part => part.type === 'tool-call' && pending.has(part.toolCallId))) {
      return safeBoundaryBefore(messages, i)
    }
  }
  return 0
}

function earliestProtectedIndex(messages: ModelMessage[]): number | null {
  const indexes = [findPendingTurnAbortedIndex(messages), findPendingUserQuestionIndex(messages),
    findTrailingTurnInputBatchStart(messages)].filter((index): index is number => index !== null)
  return indexes.length ? Math.min(...indexes) : null
}

export function findTrailingTurnInputBatchStart(messages: readonly ModelMessage[]): number | null {
  if (!messages.length || !isPendingTurnInput(messages.at(-1)!)) return null
  let start = messages.length - 1
  while (start > 0 && isPendingTurnInput(messages[start - 1]!)) start--
  return start
}

function isPendingTurnInput(message: ModelMessage): boolean {
  if (message.role !== 'user') return false
  const text = modelMessageText(message)
  return Boolean(userTurn(message)) || isCommandTaskNotificationText(text) || isSubagentSettlementText(text)
}
