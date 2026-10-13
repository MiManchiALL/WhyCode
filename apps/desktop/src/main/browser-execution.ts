import { CodemodeSandbox } from '@earendil-works/pi-codemode'
import type { BrowserExecution } from '@whycode/core'

export interface BrowserOperation {
  name: string
  run(args: unknown, signal: AbortSignal): Promise<unknown>
}
export interface BrowserOperationRecord {
  operation: string
  status: 'not_started' | 'dispatched' | 'completed' | 'failed' | 'uncertain'
  error?: string
}

/** 一次脚本一个 VM；所有浏览器命令排队，取消不会把已发出的动作伪装成未执行。 */
export async function executeBrowserScript(code: string, operations: BrowserOperation[], signal: AbortSignal,
  progress?: (message: string) => void): Promise<BrowserExecution> {
  const journal: BrowserOperationRecord[] = []
  let queue: Promise<unknown> = Promise.resolve()
  const sandbox = new CodemodeSandbox({ timeoutMs: 60_000, memoryLimitBytes: 64 * 1024 * 1024,
    globals: operations.map(operation => ({ name: `browser.${operation.name}`, execute(args, context) {
      if (journal.length >= 100) throw new Error('本次脚本已达到 100 次浏览器操作上限')
      const record: BrowserOperationRecord = { operation: operation.name, status: 'not_started' }
      journal.push(record)
      const combined = AbortSignal.any([signal, context.signal])
      const result = queue.then(async () => {
        combined.throwIfAborted()
        record.status = 'dispatched'
        progress?.(`浏览器：${operation.name}`)
        try {
          const value = await operation.run(args, combined)
          if (combined.aborted) { record.status = 'uncertain'; combined.throwIfAborted() }
          record.status = 'completed'
          return value
        } catch (error) {
          record.status = combined.aborted ? 'uncertain' : 'failed'
          record.error = error instanceof Error ? error.message : String(error)
          throw error
        }
      })
      queue = result.catch(() => {})
      return result
    } })),
  })
  try {
    const result = await sandbox.execute(code, { signal })
    for (const record of journal) if (record.status === 'dispatched') record.status = 'uncertain'
    const imageData = new Set<string>()
    const images = result.output.filter(item => item.type === 'image').slice(0, 4)
      .filter(item => item.data.length <= 16_000_000 && ['image/png', 'image/jpeg', 'image/webp'].includes(item.mimeType))
      .filter(item => { if (imageData.has(item.data)) return false; imageData.add(item.data); return true })
      .map((item, index) => ({ name: `browser-${index + 1}.${item.mimeType.split('/')[1]}`, bytes: Buffer.from(item.data, 'base64') }))
    const output = result.output.filter(item => item.type === 'text').map(item => item.text).join('\n').slice(0, 64_000)
    const stop = result.ok ? '' : `\n停止原因：${signal.aborted ? String(signal.reason) : result.error.message}`
    const incomplete = journal.some(record => record.status !== 'completed')
    return { text: `${output}${stop}\n操作记录：${JSON.stringify(journal)}${incomplete ? '\nuncertain 表示已发出但未确认完成；not_started 仅指脚本已请求但尚未派发的操作。' : ''}`,
      isError: !result.ok || incomplete, images }
  } finally { await sandbox.close() }
}
