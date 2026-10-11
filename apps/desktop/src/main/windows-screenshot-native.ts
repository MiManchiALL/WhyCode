import { findWindowSource, selectWindowSource } from './screenshot-selection.ts'
import { launchScreenshotApplication } from './windows-screenshot-launch.ts'
import { api, listScreenshotWindows, preserveScreenshotWindow, showScreenshotWindow, windowSize } from './windows-screenshot-win32.ts'

export interface PreparedScreenshotWindow {
  id: string
  name: string
  size: { width: number; height: number }
  launched: boolean
  restore(): Promise<void>
}

export async function prepareScreenshotWindow(
  title: string,
  applicationPath: string | undefined,
  signal: AbortSignal,
): Promise<PreparedScreenshotWindow> {
  signal.throwIfAborted()
  const windows = listScreenshotWindows()
  const selected = findWindowSource(windows, title)
  if (!selected && applicationPath) return launchScreenshotApplication(applicationPath, title, signal)
  const window = selected ?? selectWindowSource(windows, title)
  if (api.visible(window.handle) && !api.minimized(window.handle)) {
    return { ...window, size: windowSize(window.handle), launched: false, restore: async () => {} }
  }
  const lease = preserveScreenshotWindow(window, false)
  try {
    lease.conceal()
    await showScreenshotWindow(window.handle, signal)
    return { ...window, size: windowSize(window.handle), launched: false, restore: () => lease.restore() }
  } catch (error) {
    await lease.restore()
    throw error
  }
}
