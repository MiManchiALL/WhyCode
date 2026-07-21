import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { utilityProcess } from 'electron'

const STDERR_MAX_CHARS = 8_000

export type UtilityProcessJobFailure = 'aborted' | 'exited' | 'timeout' | 'unavailable'

export class UtilityProcessJobError extends Error {
  readonly failure: UtilityProcessJobFailure

  constructor(failure: UtilityProcessJobFailure, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'UtilityProcessJobError'
    this.failure = failure
  }
}

export interface UtilityProcessJobOptions {
  workerName: string
  serviceName: string
  request: { id: string }
  abortSignal: AbortSignal
  timeoutMs: number
  maxOldSpaceSizeMb: number
}

/**
 * Run one bounded job in a fresh Electron utility process. Business protocols
 * validate and interpret the returned message; this module owns only process
 * lifetime, cancellation, timeout and bounded diagnostics.
 */
export function runUtilityProcessJob(
  options: UtilityProcessJobOptions,
): Promise<unknown> {
  if (options.abortSignal.aborted) {
    return Promise.reject(new UtilityProcessJobError('aborted', 'Utility Process 任务已取消'))
  }

  const workerPath = join(dirname(fileURLToPath(import.meta.url)), options.workerName)
  let child: ReturnType<typeof utilityProcess.fork>
  try {
    child = utilityProcess.fork(workerPath, [], {
      serviceName: options.serviceName,
      stdio: 'pipe',
      execArgv: [`--max-old-space-size=${options.maxOldSpaceSizeMb}`],
    })
  } catch (error) {
    return Promise.reject(new UtilityProcessJobError(
      'unavailable',
      'Utility Process 启动失败',
      { cause: error },
    ))
  }

  return new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      options.abortSignal.removeEventListener('abort', onAbort)
      child.kill()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(
      new UtilityProcessJobError('aborted', 'Utility Process 任务已取消'),
    )
    const timeout = setTimeout(
      () => finish(new UtilityProcessJobError('timeout', 'Utility Process 任务超时')),
      options.timeoutMs,
    )

    options.abortSignal.addEventListener('abort', onAbort, { once: true })
    child.stdout?.resume()
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-STDERR_MAX_CHARS)
    })
    child.once('spawn', () => {
      if (!settled) child.postMessage(options.request)
    })
    child.once('message', (message) => finish(undefined, message))
    child.once('error', (error) => finish(new UtilityProcessJobError(
      'unavailable',
      'Utility Process 启动失败',
      { cause: error },
    )))
    child.once('exit', (code) => {
      const suffix = stderr.trim() ? `：${stderr.trim()}` : ''
      finish(new UtilityProcessJobError(
        'exited',
        `Utility Process 异常退出（${code}）${suffix}`,
      ))
    })
    if (options.abortSignal.aborted) onAbort()
  })
}
