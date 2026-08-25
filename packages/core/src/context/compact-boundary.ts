import type { ModelMessage } from 'ai'
import {
  isCompactApplicationContextMessage,
  parseCompactSummaryMessage,
  type CompactSummaryState,
} from '../prompts/compact.ts'
import { findPendingTurnAbortedIndex } from '../session/interruption.ts'
import { findPendingUserQuestionIndex } from '../tasks/answer-resume.ts'
import { isCommandTaskNotificationText } from '../tools/background-command/notification.ts'
import { isSubagentSettlementText } from '../subagents/notification.ts'
import { modelMessageText } from '../text.ts'
import { estimateMessageTokens } from './tokens.ts'

export const COMPACT_KEEP_RECENT_TOKENS = 20_000

export interface SummarySource {
  previousSummary: string | null
  completedTurnPrefixSummary: string | null
  messages: ModelMessage[]
}

export interface CompactionPreparation {
  carriedHistorySummary: string | null
  historySource: SummarySource | null
  turnPrefixSource: SummarySource | null
  tail: ModelMessage[]
}

/**
 * 按精确尾部预算划分消息。切点可以位于同一 turn 的 assistant 边界，
 * 但绝不落在 tool result 上；未消费控制边界及其后消息始终逐字保留。
 */
export function prepareCompaction(
  messages: ModelMessage[],
  keepRecentTokens = COMPACT_KEEP_RECENT_TOKENS,
): CompactionPreparation | null {
  const { summary, messages: rawMessages } = extractPreviousSummary(messages)
  const budgetStart = pickBudgetStart(rawMessages, keepRecentTokens)
  if (budgetStart === 0) return null

  const protectedStart = earliestProtectedIndex(rawMessages)
  const tailStart = protectedStart !== null && protectedStart <= budgetStart
    ? protectedStart
    : budgetStart

  const firstRetainedUser = findRealUserAtOrAfter(rawMessages, tailStart)
  if (firstRetainedUser !== null) {
    // 预算内已经包含真实用户输入，不需要另建 turn 前缀摘要；切点仍保持纯 token 结果。
    const historyMessages = rawMessages.slice(0, tailStart)
    return {
      carriedHistorySummary: summary.historySummary,
      historySource: needsHistoryUpdate(historyMessages, summary.turnPrefixSummary)
        ? {
            previousSummary: summary.historySummary,
            completedTurnPrefixSummary: summary.turnPrefixSummary,
            messages: historyMessages,
          }
        : null,
      turnPrefixSource: null,
      tail: rawMessages.slice(tailStart),
    }
  }

  const turnStart = findPreviousRealUser(rawMessages, tailStart)
  if (turnStart !== null) {
    const historyMessages = rawMessages.slice(0, turnStart)
    return {
      carriedHistorySummary: summary.historySummary,
      historySource: needsHistoryUpdate(historyMessages, summary.turnPrefixSummary)
        ? {
            previousSummary: summary.historySummary,
            completedTurnPrefixSummary: summary.turnPrefixSummary,
            messages: historyMessages,
          }
        : null,
      turnPrefixSource: {
        previousSummary: null,
        completedTurnPrefixSummary: null,
        messages: rawMessages.slice(turnStart, tailStart),
      },
      tail: rawMessages.slice(tailStart),
    }
  }

  // 上一次已经切在同一 turn 内：只增量更新该 turn 的前缀摘要。
  if (summary.turnPrefixSummary) {
    return {
      carriedHistorySummary: summary.historySummary,
      historySource: null,
      turnPrefixSource: {
        previousSummary: summary.turnPrefixSummary,
        completedTurnPrefixSummary: null,
        messages: rawMessages.slice(0, tailStart),
      },
      tail: rawMessages.slice(tailStart),
    }
  }

  // 没有真实用户起点也没有既有前缀摘要，无法可靠说明保留的 assistant 后缀。
  return null
}

/** 从末尾回扫约定预算；命中 tool result 时向前扩到所属 assistant 消息。 */
export function pickBudgetStart(
  messages: readonly ModelMessage[],
  keepRecentTokens = COMPACT_KEEP_RECENT_TOKENS,
): number {
  let tokens = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    tokens += estimateMessageTokens(messages[index]!)
    if (tokens < keepRecentTokens) continue
    let start = index
    if (messages[start]!.role === 'tool') {
      while (start > 0 && messages[start]!.role === 'tool') start--
      if (messages[start]!.role !== 'assistant' || !hasToolCall(messages[start]!)) return 0
    }
    while (start > 0 && !isSafeBoundary(messages[start]!)) start--
    return start
  }
  return 0
}

function hasToolCall(message: ModelMessage): boolean {
  return message.role === 'assistant'
    && typeof message.content !== 'string'
    && message.content.some((part) => part.type === 'tool-call')
}

function extractPreviousSummary(messages: ModelMessage[]): {
  summary: CompactSummaryState
  messages: ModelMessage[]
} {
  const parsed = messages[0] ? parseCompactSummaryMessage(messages[0]) : null
  const rawMessages = (parsed ? messages.slice(1) : messages)
    .filter((message) => !isCompactApplicationContextMessage(message))
  return parsed
    ? { summary: parsed, messages: rawMessages }
    : {
        summary: { historySummary: null, turnPrefixSummary: null },
        messages: rawMessages,
      }
}

function earliestProtectedIndex(messages: ModelMessage[]): number | null {
  const indexes = [
    findPendingTurnAbortedIndex(messages),
    findPendingUserQuestionIndex(messages),
    findTrailingTurnInputBatchStart(messages),
  ].filter((index): index is number => index !== null)
  return indexes.length > 0 ? Math.min(...indexes) : null
}

export function findTrailingTurnInputBatchStart(messages: readonly ModelMessage[]): number | null {
  if (messages.length === 0 || !isPendingTurnInput(messages.at(-1)!)) return null
  let start = messages.length - 1
  while (start > 0 && isPendingTurnInput(messages[start - 1]!)) start--
  return start
}

function isPendingTurnInput(message: ModelMessage): boolean {
  return isRealUserMessage(message)
    || (message.role === 'user' && isInternalContinuation(modelMessageText(message)))
}

function findRealUserAtOrAfter(
  messages: readonly ModelMessage[],
  start: number,
): number | null {
  for (let index = start; index < messages.length; index++) {
    if (isRealUserMessage(messages[index]!)) return index
  }
  return null
}

function findPreviousRealUser(
  messages: readonly ModelMessage[],
  before: number,
): number | null {
  for (let index = before - 1; index >= 0; index--) {
    if (isRealUserMessage(messages[index]!)) return index
  }
  return null
}

function isSafeBoundary(message: ModelMessage): boolean {
  return message.role === 'user' || message.role === 'assistant'
}

function isRealUserMessage(message: ModelMessage): boolean {
  if (message.role !== 'user') return false
  const text = modelMessageText(message).trimStart()
  return !text.startsWith('<system-reminder>') && !isInternalContinuation(text)
}

function isInternalContinuation(text: string): boolean {
  return isCommandTaskNotificationText(text) || isSubagentSettlementText(text)
}

function needsHistoryUpdate(
  messages: readonly ModelMessage[],
  completedTurnPrefixSummary: string | null,
): boolean {
  return messages.length > 0 || completedTurnPrefixSummary !== null
}
