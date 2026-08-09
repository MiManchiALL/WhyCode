export interface RendererExitDetails {
  reason: string
  exitCode: number
}

interface RendererCrashRecoveryOptions {
  isShuttingDown: () => boolean
  isUnavailable: () => boolean
  reload: () => void
  schedule?: (callback: () => void, delayMs: number) => void
  recoveryDelayMs?: number
}

export interface RendererCrashRecoveryController {
  rendererGone: (details: RendererExitDetails) => boolean
  rendererLoaded: () => void
}

/**
 * Renderer 是 Core/JSONL 的可重建投影。崩溃后只安排一次重载，并等页面真正
 * 加载完成后再解除闸门，避免故障页面形成 reload 循环。
 */
export function createRendererCrashRecoveryController(
  options: RendererCrashRecoveryOptions,
): RendererCrashRecoveryController {
  let recoveryPending = false
  const schedule = options.schedule ?? ((callback, delayMs) => {
    setTimeout(callback, delayMs)
  })
  const recoveryDelayMs = options.recoveryDelayMs ?? 500

  return {
    rendererGone(details) {
      if (
        details.reason === 'clean-exit'
        || recoveryPending
        || options.isShuttingDown()
        || options.isUnavailable()
      ) {
        return false
      }
      recoveryPending = true
      schedule(() => {
        if (!options.isShuttingDown() && !options.isUnavailable()) {
          options.reload()
        }
      }, recoveryDelayMs)
      return true
    },
    rendererLoaded() {
      recoveryPending = false
    },
  }
}
