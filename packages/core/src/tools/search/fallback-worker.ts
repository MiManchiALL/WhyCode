import { Worker } from 'node:worker_threads'

type MatchRequest = { kind: 'glob'; files: string[]; expression: string; limit: number } | {
  kind: 'grep'; files: { path: string; text: string }[]; pattern: string; literal: boolean;
  caseSensitive: boolean; mode: 'content' | 'files_with_matches' | 'count'; context: number; limit: number
}

// JS 正则可能在一次 test 中耗尽预算，必须由主线程能够终止的 Worker 执行。
const MATCH_WORKER = String.raw`
const { parentPort, workerData: o } = require('node:worker_threads')
if (o.kind === 'glob') {
  const expression = new RegExp(o.expression)
  parentPort.postMessage(o.files.filter(path => expression.test(path)).sort().slice(0, o.limit))
} else {
  const expression = new RegExp(o.literal ? o.pattern.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&') : o.pattern, o.caseSensitive ? '' : 'i')
  const output = []
  for (const file of o.files) {
    const lines = file.text.split('\n')
    let count = 0
    let lastShown = -1
    for (let index = 0; index < lines.length; index++) {
      if (!expression.test(lines[index])) continue
      count++
      if (o.mode === 'files_with_matches') { output.push(file.path); break }
      if (o.mode === 'count') continue
      const from = Math.max(0, index - o.context)
      const to = Math.min(lines.length - 1, index + o.context)
      if (o.context && lastShown >= 0 && from > lastShown + 1) output.push('--')
      for (let n = Math.max(from, lastShown + 1); n <= to && output.length < o.limit; n++) {
        output.push(file.path + ':' + (n + 1) + ':' + lines[n].slice(0, 500))
        lastShown = n
      }
      if (output.length >= o.limit) break
    }
    if (o.mode === 'count' && count) output.push(file.path + ':' + count)
    if (output.length >= o.limit) break
  }
  parentPort.postMessage(output.slice(0, o.limit))
}
`

export async function matchFallback(workerData: MatchRequest, signal: AbortSignal): Promise<string[]> {
  signal.throwIfAborted()
  const worker = new Worker(MATCH_WORKER, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 }, workerData })
  let abort: () => void = () => {}
  try {
    return await new Promise<string[]>((resolve, reject) => {
      worker.once('message', resolve)
      worker.once('error', reject)
      worker.once('exit', code => reject(new Error(`搜索匹配进程提前退出（${code}）`)))
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  } finally {
    signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

