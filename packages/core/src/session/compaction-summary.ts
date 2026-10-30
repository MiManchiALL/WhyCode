import { open } from 'node:fs/promises'
import { parseCompactSummaryMessage } from '../prompts/compact.ts'
import { sessionEntrySchema } from './types.ts'

export interface SessionCompactionSummary {
  index: number
  timestamp: string
  preTokens: number
  postTokens: number
  historySummary: string | null
  turnPrefixSummary: string | null
}

/** 完整压缩事件按写入顺序编号；摘要来自其先写稳的 compact snapshot，不复制进展示事件。 */
export async function readSessionCompaction(
  transcriptPath: string,
  requestedIndex: number,
): Promise<SessionCompactionSummary> {
  const file = await open(transcriptPath, 'r')
  let index = 0
  let summary: Pick<SessionCompactionSummary, 'historySummary' | 'turnPrefixSummary'> | null = null
  try {
    for await (const line of file.readLines({ autoClose: false })) {
      if (!line.trim()) continue
      const entry = sessionEntrySchema.parse(JSON.parse(line))
      if (entry.type === 'snapshot') {
        summary = null
        if (entry.reason !== 'compact') continue
        for (const message of entry.messages) {
          const parsed = parseCompactSummaryMessage(message)
          if (!parsed) continue
          summary ??= { historySummary: null, turnPrefixSummary: null }
          if (parsed.historySummary) summary.historySummary = parsed.historySummary
          if (parsed.turnPrefixSummary) summary.turnPrefixSummary = parsed.turnPrefixSummary
        }
      }
      if (entry.type !== 'view-events') continue
      for (const view of entry.events) {
        if (view.type !== 'core-event' || view.event.type !== 'context-compacted') continue
        const event = view.event
        if (event.level === 'full' && ++index === requestedIndex) {
          if (!summary) throw new Error('该次压缩缺少已保存的摘要')
          return {
            index, timestamp: entry.timestamp,
            preTokens: event.preTokens, postTokens: event.postTokens, ...summary,
          }
        }
        summary = null
      }
    }
  } finally {
    await file.close()
  }
  throw new Error('找不到该次完整压缩记录')
}
