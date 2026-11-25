import { SessionCorruptError } from './chain.ts'
import { getSessionPaths } from './metadata.ts'
import { readTranscriptEntries } from './transcript-reader.ts'
import type { SessionForkOrigin } from './types.ts'

/** 只读首条会话起点，避免为同族编号打开全部历史记录。 */
export async function readSessionStartOrigin(
  rootDir: string,
  sessionId: string,
): Promise<SessionForkOrigin | null> {
  for await (const entry of readTranscriptEntries(getSessionPaths(rootDir, sessionId).transcript)) {
    if (entry.type !== 'session-start') throw new SessionCorruptError('会话缺少起始记录')
    return entry.forkOrigin
  }
  throw new SessionCorruptError('会话记录为空')
}
