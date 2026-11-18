import { on } from 'node:events'
import { Worker } from 'node:worker_threads'
import type { SearchPage, SearchRow } from './page.ts'

export interface GrepOptions {
  pattern: string
  literal: boolean
  caseSensitive: boolean
  mode: 'content' | 'files_with_matches' | 'count'
  context: number
}
export interface SearchFile { path: string; text: string }

// 不可信正则可能卡在单次 test。一次搜索共用一个可终止的 Worker，每次只传一批文件。
const MATCH_WORKER = String.raw`
const { parentPort, workerData: o } = require('node:worker_threads')
const expression = new RegExp(o.literal ? o.pattern.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&') : o.pattern, o.caseSensitive ? '' : 'i')
parentPort.on('message', ({files, skip, limit}) => {
  let skipped = 0
  const rows = []
  for (const file of files) {
    const lines = file.text.replaceAll('\r\n', '\n').split('\n')
    if (lines.at(-1) === '') lines.pop()
    let count = 0
    let lastShown = -1
    for (let index = 0; index < lines.length; index++) {
      if (!expression.test(lines[index])) continue
      count++
      if (o.mode === 'files_with_matches') break
      if (o.mode === 'count') continue
      const end = Math.min(lines.length - 1, index + o.context)
      for (let n = Math.max(lastShown + 1, index - o.context); n <= end; n++) {
        if (skipped < skip) { skipped++; continue }
        const separator = n === index || expression.test(lines[n]) ? ':' : '-'
        rows.push({path: file.path, line: (n + 1) + separator + lines[n].slice(0, 500)})
        if (rows.length >= limit) break
      }
      lastShown = end
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
      const reply = await messages.next()
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
