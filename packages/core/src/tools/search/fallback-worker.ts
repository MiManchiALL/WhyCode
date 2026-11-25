import { on } from 'node:events'
import { Worker } from 'node:worker_threads'
import { unicodeSafeSuffix } from '../../text.ts'
import type { SearchPage, SearchRow } from './page.ts'
import { ToolResultError } from '../tool.ts'

export interface GrepOptions {
  pattern: string
  caseSensitive: boolean
  mode: 'content' | 'files_with_matches' | 'count'
}
export interface SearchFile { path: string; text: string }

// 不可信正则可能卡在单次 test。一次搜索共用一个可终止的 Worker，每次只传一批文件。
const MATCH_WORKER = String.raw`
const { parentPort, workerData: o } = require('node:worker_threads')
const expression = new RegExp(o.pattern, o.caseSensitive ? '' : 'i')
parentPort.on('message', ({files, skip, limit}) => {
  let skipped = 0
  const rows = []
  for (const file of files) {
    const lines = file.text.replaceAll('\r\n', '\n').split('\n')
    if (lines.at(-1) === '') lines.pop()
    let count = 0
    for (let index = 0; index < lines.length; index++) {
      if (!expression.test(lines[index])) continue
      count++
      if (o.mode === 'files_with_matches') break
      if (o.mode === 'count') continue
      if (skipped < skip) { skipped++; continue }
      rows.push({path: file.path, line: (index + 1) + ':' + lines[index].slice(0, 500)})
      if (rows.length >= limit) break
    }
    if (o.mode !== 'content' && count) {
      if (skipped < skip) skipped++
      else rows.push(o.mode === 'count' ? file.path + ':' + count : file.path)
    }
    if (rows.length >= limit) break
  }
  parentPort.postMessage({skipped, rows})
})
`

export async function matchFallbackBatches(options: GrepOptions, batches: AsyncIterable<SearchFile[]>, signal: AbortSignal, page: SearchPage): Promise<void> {
  signal.throwIfAborted()
  const worker = new Worker(MATCH_WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 }, workerData: options })
  const messages = on(worker, 'message', { signal, close: ['exit'] })
  try {
    for await (const files of batches) {
      signal.throwIfAborted()
      worker.postMessage({ files, skip: page.remainingSkip, limit: page.limit + 1 })
      const reply = await messages.next().catch(error => {
        if (error instanceof SyntaxError) {
          // V8 会把整个表达式插入消息，具体语法错误在末尾。
          let detail = error.message
          if (detail.length > 512) detail = detail.replace(options.pattern, '…')
          if (detail.length > 512) detail = '无效正则：…' + unicodeSafeSuffix(detail, 256)
          throw new ToolResultError(detail, { cause: error })
        }
        throw error
      })
      if (reply.done) throw new Error('搜索匹配进程提前退出')
      const result: { skipped: number; rows: SearchRow[] } = reply.value[0]
      page.remainingSkip -= result.skipped
      if (!result.rows.every(row => page.add(row))) break
    }
  } finally {
    await messages.return?.()
    await worker.terminate()
  }
}
