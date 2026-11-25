import { open } from 'node:fs/promises'
import { sessionEntrySchema, type SessionEntry } from './types.ts'

/** JSONL 只按 LF 分隔记录，字符串中的 U+2028 和 U+2029 都是正文。 */
export async function* readTranscriptEntries(path: string): AsyncGenerator<SessionEntry> {
  const file = await open(path, 'r')
  try {
    const stream: AsyncIterable<string> = file.createReadStream({ encoding: 'utf8', autoClose: false })
    let partial = ''
    for await (const chunk of stream) {
      let start = 0
      let end: number
      while ((end = chunk.indexOf('\n', start)) !== -1) {
        const line = partial + chunk.slice(start, end)
        partial = ''
        start = end + 1
        if (line.trim()) yield parseEntry(line)
      }
      partial += chunk.slice(start)
    }
    if (partial.trim()) yield parseEntry(partial)
  } finally {
    await file.close()
  }
}

function parseEntry(line: string): SessionEntry {
  return sessionEntrySchema.parse(JSON.parse(line))
}
