import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

interface QueueEntry {
  tail: Promise<void>
  pending: number
}

/**
 * 宿主级副作用调度。不同项目互不阻塞；同一项目的 edit/execute 从审批到
 * 检查点收尾保持一个临界区。桌面截图使用独立全局键，避免窗口隐藏/恢复交错。
 */
export class HostOperationScheduler {
  private readonly queues = new Map<string, QueueEntry>()

  runProjectWrite<T>(
    projectDir: string,
    abortSignal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue(`project:${normalizePath(projectDir)}`, abortSignal, operation)
  }

  runScreenshot<T>(
    abortSignal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.enqueue('host:screenshot', abortSignal, operation)
  }

  private enqueue<T>(
    key: string,
    abortSignal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const queue = this.queues.get(key) ?? { tail: Promise.resolve(), pending: 0 }
    queue.pending++
    let started = false
    const run = queue.tail.then(async () => {
      started = true
      if (abortSignal.aborted) throw abortError()
      return operation()
    })
    queue.tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.queues.set(key, queue)
    const completion = run.finally(() => {
      queue.pending--
      if (queue.pending === 0 && this.queues.get(key) === queue) {
        this.queues.delete(key)
      }
    })
    return new Promise<T>((resolve, reject) => {
      let rejectedWhileWaiting = false
      const onAbort = () => {
        if (started || rejectedWhileWaiting) return
        rejectedWhileWaiting = true
        reject(abortError())
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      if (abortSignal.aborted) onAbort()
      void completion.then(
        (value) => {
          if (!rejectedWhileWaiting) resolve(value)
        },
        (error) => {
          if (!rejectedWhileWaiting) reject(error)
        },
      ).finally(() => abortSignal.removeEventListener('abort', onAbort))
    })
  }
}

function normalizePath(path: string): string {
  const absolute = resolve(path)
  let normalized = absolute
  try {
    normalized = realpathSync.native(absolute)
  } catch {
    // 已删除或暂时不可访问的目录仍按规范化绝对路径排队，实际工具负责报告错误。
  }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function abortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}
