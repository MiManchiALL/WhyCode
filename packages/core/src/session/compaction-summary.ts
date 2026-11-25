import { parseCompactSummaryMessage } from '../prompts/compact.ts'
import { responseViewEvents } from './response-view.ts'
import { readTranscriptEntries } from './transcript-reader.ts'

export interface SessionCompactionSummary {
  index: number
  timestamp: string
  preTokens: number
  postTokens: number
  historySummary: string | null
  turnPrefixSummary: string | null
}

/** 按提交顺序读取完整压缩与快照中的摘要，微压缩不占用序号。 */
export async function readSessionCompaction(
  transcriptPath: string,
  requestedIndex: number,
): Promise<SessionCompactionSummary> {
  let index = 0
  let summary: Pick<SessionCompactionSummary, 'historySummary' | 'turnPrefixSummary'> | null = null
  for await (const entry of readTranscriptEntries(transcriptPath)) {
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
    } else if (entry.type !== 'view-events') continue
    const events = entry.type === 'snapshot' ? responseViewEvents(entry) : entry.events
    for (const view of events) {
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
  throw new Error('找不到该次完整压缩记录')
}
