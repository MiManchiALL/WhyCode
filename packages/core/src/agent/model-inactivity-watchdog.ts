export const MODEL_INACTIVITY_ABORT_REASON = 'model-inactivity-timeout'
export const MODEL_INACTIVITY_TIMEOUT_MS = 120_000

/**
 * 只限制模型传输无活动时间；工具、审批等本地等待期间暂停计时，
 * 因此不会把长命令的合法运行时间误当成模型卡死。
 */
export class ModelInactivityWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null
  private activeTools = 0
  private stopped = false
  private readonly controller: AbortController
  private readonly timeoutMs: number

  constructor(
    controller: AbortController,
    timeoutMs = MODEL_INACTIVITY_TIMEOUT_MS,
  ) {
    this.controller = controller
    this.timeoutMs = timeoutMs
  }

  start(): void {
    this.arm()
  }

  noteStreamActivity(): void {
    if (this.activeTools === 0) this.arm()
  }

  toolStarted(): void {
    this.activeTools++
    this.clearTimer()
  }

  toolEnded(): void {
    if (this.activeTools > 0) this.activeTools--
    if (this.activeTools === 0) this.arm()
  }

  stop(): void {
    this.stopped = true
    this.clearTimer()
  }

  private arm(): void {
    if (this.stopped || this.controller.signal.aborted) return
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.controller.abort(MODEL_INACTIVITY_ABORT_REASON)
    }, this.timeoutMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
