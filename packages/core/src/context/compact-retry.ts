import type { ModelMessage } from 'ai'
import { pickBudgetStart, prepareCompaction, safeBoundaryBefore, type CompactionPreparation, type SummarySource } from './compact-boundary.ts'
import { userTurn } from './user-turn.ts'

export const COMPACT_PTL_MAX_RETRIES = 3

/** 从失败摘要的末端退到完整步骤；旧摘要不属于可移动记录，所有原始后缀一起保留。 */
export function expandCompactionTail(
  conversation: ModelMessage[],
  source: SummarySource,
  fallbackTokens: number,
  tokenGap?: number,
): CompactionPreparation | null {
  const movable = [...(source.userMessage ? [source.userMessage] : []), ...source.messages]
  const target = tokenGap === undefined ? fallbackTokens
    : tokenGap + Math.max(256, Math.ceil(tokenGap * 0.05))
  let start = pickBudgetStart(movable, Math.max(1, target))
  // 插话和通知随所在步骤保留，不能只移走工具结果之后的一条通知。
  while (start > 0 && !isStepStart(movable[start]!)) start--
  // 差额大于可移动记录时，尽量保留仍有可摘要内容的最大尾部；不能退成空摘要。
  for (let index = start; index < movable.length; index++) {
    if (!isStepStart(movable[index]!) || safeBoundaryBefore(movable, index) !== index) continue
    const next = prepareCompaction(conversation, 0, false, movable[index])
    if (next) return next
  }
  return null
}

function isStepStart(message: ModelMessage): boolean {
  return message.role === 'assistant' || userTurn(message)?.startsTurn === true
}
