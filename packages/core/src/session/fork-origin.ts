import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { SessionCorruptError } from './chain.ts'
import { getSessionPaths } from './metadata.ts'
import { sessionEntrySchema, type SessionForkOrigin } from './types.ts'

/** 只读首条会话起点，避免为同族编号打开全部历史记录。 */
export async function readSessionStartOrigin(
  rootDir: string,
  sessionId: string,
): Promise<SessionForkOrigin | null> {
  const transcript = createInterface({
    input: createReadStream(getSessionPaths(rootDir, sessionId).transcript, {
      encoding: 'utf8',
    }),
    crlfDelay: Infinity,
  })
  let firstLine: string | null = null
  try {
    for await (const line of transcript) {
      if (!line.trim()) continue
      firstLine = line
      break
    }
  } finally {
    transcript.close()
  }
  if (firstLine === null) throw new SessionCorruptError('会话记录为空')
  const start = sessionEntrySchema.parse(JSON.parse(firstLine))
  if (start.type !== 'session-start') throw new SessionCorruptError('会话缺少起始记录')
  return start.forkOrigin
}
