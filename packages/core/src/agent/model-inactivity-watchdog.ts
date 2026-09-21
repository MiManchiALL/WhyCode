export const MODEL_INACTIVITY_ABORT_REASON = 'model-inactivity-timeout'
export const MODEL_INACTIVITY_TIMEOUT_MS = 120_000

/**
 * 只限制模型传输无活动时间；完整模型响应到达后、进入本地工具与审批前停止。
 */
export class ModelInactivityWatchdog {
  private timer: ReturnType<typeof setTimeout> | null = null
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
    this.arm()
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
