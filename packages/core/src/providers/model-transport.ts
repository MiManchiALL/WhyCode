import { ModelRequestError } from './model-request.ts'

export const MODEL_REQUEST_IDLE_TIMEOUT_MS = 300_000

/** 每次实际 fetch 独立持有取消器；超时只取消这一请求，不取消所属步骤的重试资格。 */
export function createModelFetch(
  fetchRequest: typeof fetch = (...args) => globalThis.fetch(...args),
  idleTimeoutMs = MODEL_REQUEST_IDLE_TIMEOUT_MS,
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
    let requestId: string | null = null
    let status: number | undefined

    async function waitForData<T>(operation: () => Promise<T>, phase: string): Promise<T> {
      const startedAt = Date.now()
      const timer = setTimeout(() => {
        controller.abort(new ModelRequestError(
          `模型请求超时：${phase}，连续 ${Math.round((Date.now() - startedAt) / 1000)} 秒没有传输数据`
            + `${status === undefined ? '' : `（HTTP ${status}）`}${requestId ? `；请求 ID：${requestId}` : ''}`,
          true,
        ))
      }, idleTimeoutMs)
      timer.unref?.()
      try {
        signal.throwIfAborted()
        return await operation()
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason
        if (parent?.aborted) throw error
        // SDK 已区分 fetch 的网络故障与无效 URL/请求参数，保留其原始分类依据。
        if (phase === '等待服务器响应') throw error
        // 此处只有网络 I/O；保留阶段与底层原因，SDK 包装后仍可准确恢复分类。
        const message = error instanceof Error ? error.message : String(error)
        throw new ModelRequestError(
          `模型连接中断：${phase}（${message}）${requestId ? `；请求 ID：${requestId}` : ''}`,
          true, undefined, { cause: error },
        )
      } finally {
        clearTimeout(timer)
      }
    }

    const response = await waitForData(() => fetchRequest(input, { ...init, signal }), '等待服务器响应')
    status = response.status
    requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id')
    if (!response.body) return response
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      async pull(destination) {
        try {
          const next = await waitForData(() => reader.read(), '读取响应数据')
          if (next.done) {
            reader.releaseLock()
            destination.close()
          } else {
            destination.enqueue(next.value)
          }
        } catch (error) {
          reader.releaseLock()
          destination.error(error)
        }
      },
      async cancel(reason) {
        controller.abort(reason)
        try { await reader.cancel(reason) } finally { reader.releaseLock() }
      },
    }, { highWaterMark: 0 })
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

export const modelFetch = createModelFetch()
