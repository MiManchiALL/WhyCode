export interface ScreenshotHostWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isFocused(): boolean
  isContentProtected(): boolean
  setContentProtection(enabled: boolean): void
  hide(): void
  show(): void
}

export type ScreenshotHostExclusionMode = 'content-protection' | 'hide-focused'

export async function captureWithHostExcluded<T>(
  hostWindow: ScreenshotHostWindow | null,
  options: {
    mode: ScreenshotHostExclusionMode
    settleAfterHide?: () => Promise<void>
    capture: () => Promise<T>
  },
): Promise<{ result: T; hostExcluded: boolean }> {
  if (!hostWindow || hostWindow.isDestroyed() || !hostWindow.isVisible()) {
    return { result: await options.capture(), hostExcluded: false }
  }

  if (options.mode === 'content-protection') {
    // Windows 可在不隐藏或改焦点的情况下从 DWM 采集排除宿主；必须恢复原状态，
    // 否则用户之后主动截取 WhyCode 也会得到空白。
    const restoreProtection = !hostWindow.isContentProtected()
    if (restoreProtection) hostWindow.setContentProtection(true)
    try {
      return { result: await options.capture(), hostExcluded: true }
    } finally {
      if (restoreProtection && !hostWindow.isDestroyed()) {
        hostWindow.setContentProtection(false)
      }
    }
  }

  if (!hostWindow.isFocused()) {
    return { result: await options.capture(), hostExcluded: false }
  }
  // 其它平台没有同等可靠的宿主排除能力；只隐藏正在遮挡目标的前台窗口，
  // 避免把后台 WhyCode 无谓地提到新的 z-order。
  hostWindow.hide()
  try {
    await options.settleAfterHide?.()
    return { result: await options.capture(), hostExcluded: true }
  } finally {
    if (!hostWindow.isDestroyed()) hostWindow.show()
  }
}
