import { selectWindowSource } from './screenshot-selection.ts'
import type { WindowsScreenshotRequest } from './windows-screenshot.ts'
import { api, listScreenshotWindows, preserveScreenshotWindow, showScreenshotWindow, windowSize } from './windows-screenshot-win32.ts'

export interface PreparedScreenshotWindow {
  id: string
  name: string
  size: { width: number; height: number }
  restore(): Promise<void>
}

export async function prepareScreenshotWindow(
  { windowTitle, windowId }: WindowsScreenshotRequest,
  signal: AbortSignal,
): Promise<PreparedScreenshotWindow> {
  signal.throwIfAborted()
  const window = selectWindowSource(listScreenshotWindows(), windowTitle, windowId)
  const id = String(window.handle)
  if (api.visible(window.handle) && !api.minimized(window.handle)) {
    return { id, name: window.name, size: windowSize(window.handle), restore: async () => {} }
  }
  const lease = preserveScreenshotWindow(window)
  try {
    lease.conceal()
    await showScreenshotWindow(window.handle, signal)
    return { id, name: window.name, size: windowSize(window.handle), restore: lease.restore }
  } catch (error) {
    await lease.restore()
    throw error
  }
}
