import type { ToolContext, ToolResult } from '../tool.ts'

export const SEARCH_TIMEOUT_MS = 30_000

/** 搜索超时只结束本次工具，不取消模型回合；目录检查和回退也共用这一预算。 */
export async function withSearchDeadline(
  ctx: ToolContext,
  search: (ctx: ToolContext) => Promise<ToolResult>,
): Promise<ToolResult> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([ctx.abortSignal, deadline.signal])
  const error = new Error('搜索超时（30 秒）；请缩小搜索目录或匹配范围后重试')
  const timer = setTimeout(() => deadline.abort(error), SEARCH_TIMEOUT_MS)
  let onAbort: () => void = () => {}
  try {
    signal.throwIfAborted()
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    const result = await Promise.race([search({ ...ctx, abortSignal: signal }), cancelled])
    signal.throwIfAborted()
    return result
  } catch (failure) {
    if (failure === error) return { data: error.message, isError: true }
    throw failure
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}
