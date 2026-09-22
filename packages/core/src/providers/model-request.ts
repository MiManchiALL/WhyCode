import { setTimeout as delay } from 'node:timers/promises'
import { APICallError } from 'ai'

export const MODEL_REQUEST_MAX_RETRIES = 2

export interface ModelRequestRetry {
  retry: number
  maxRetries: number
  delayMs: number
  message: string
}

export class ModelRequestError extends Error {
  override readonly name = 'ModelRequestError'
  readonly retryable: boolean
  readonly retryAfterMs: number | undefined

  constructor(
    message: string,
    retryable: boolean,
    retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

/** 只在模型 I/O 边界分类；本地工具、持久化和用户取消不能进入请求重试。 */
export function modelRequestError(error: unknown): ModelRequestError {
  const causes = new Set<unknown>()
  let current: unknown = error
  while (current instanceof Error && !causes.has(current)) {
    if (current instanceof ModelRequestError) return current
    causes.add(current)
    current = current.cause
  }
  const message = error instanceof Error ? error.message : String(error)
  if (APICallError.isInstance(error)) {
    const status = error.statusCode
    const quota = /insufficient[_ ](?:quota|balance)|quota[_ ]exceeded|余额不足|欠费/iu.test(message)
    const retryable = !quota && (status === undefined ? error.isRetryable
      : status === 408 || status === 429 || (status >= 500 && status <= 599))
    const headers = error.responseHeaders
    const requestId = headers?.['x-request-id'] ?? headers?.['request-id']
    const retryAfter = headers?.['retry-after']
    const retryAfterMs = retryAfter === undefined ? undefined
      : Number.isFinite(Number(retryAfter)) ? Math.max(0, Number(retryAfter) * 1000)
        : Math.max(0, Date.parse(retryAfter) - Date.now())
    return new ModelRequestError(
      `${message}${status === undefined ? '' : `（HTTP ${status}）`}${requestId ? `；请求 ID：${requestId}` : ''}`,
      retryable,
      Number.isFinite(retryAfterMs) ? retryAfterMs : undefined,
      { cause: error },
    )
  }
  return new ModelRequestError(message, false, undefined, { cause: error })
}

export function emptyModelResponse(finishReason?: string | null): ModelRequestError {
  return new ModelRequestError(
    `模型没有返回可交付答复${finishReason ? `（finish reason: ${finishReason}）` : ''}`,
    true,
  )
}

/** SDK 的错误块与抛错在同一出口归一，调用者的处理异常不会误判为网络错误。 */
export async function* readModelStream<T extends { type: string }>(
  stream: AsyncIterable<T>,
): AsyncGenerator<T> {
  try {
    for await (const part of stream) {
      if (part.type === 'error' && 'error' in part) throw part.error
      // SDK 可在缺少协议终止事件时用 other 封口；不能据此提交半截正文或工具调用。
      if ((part.type === 'finish-step' || part.type === 'finish') && 'finishReason' in part
        && (part.finishReason === 'other' || part.finishReason === 'error')) {
        throw new ModelRequestError(`模型响应未正常结束（finish reason: ${part.finishReason}）`, true)
      }
      yield part
    }
  } catch (error) {
    throw modelRequestError(error)
  }
}

export async function withModelRequestRetry<T>(
  request: () => Promise<T>,
  signal: AbortSignal,
  onRetry?: (retry: ModelRequestRetry) => void,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    signal.throwIfAborted()
    try {
      return await request()
    } catch (error) {
      if (signal.aborted || !(error instanceof ModelRequestError)) throw error
      const delayMs = error.retryAfterMs ?? 500 * 2 ** retry
      if (!error.retryable || retry === MODEL_REQUEST_MAX_RETRIES || delayMs > 10_000) {
        if (retry === 0) throw error
        throw new ModelRequestError(
          `${error.message}；已重试 ${retry} 次，可稍后继续。`, false, undefined, { cause: error },
        )
      }
      onRetry?.({ retry: retry + 1, maxRetries: MODEL_REQUEST_MAX_RETRIES, delayMs, message: error.message })
      await delay(delayMs, undefined, { signal })
    }
  }
}
