import { describeWindowSource, findWindowSource, selectWindowSource } from './screenshot-selection.ts'
import { launchScreenshotApplication } from './windows-screenshot-launch.ts'
import { realpath } from 'node:fs/promises'
import { win32 } from 'node:path'
import type { WindowsScreenshotRequest } from './windows-screenshot.ts'
import { api, listScreenshotWindows, preserveScreenshotWindow, showScreenshotWindow, windowSize } from './windows-screenshot-win32.ts'

export interface PreparedScreenshotWindow {
  id: string
  name: string
  size: { width: number; height: number }
  launched: boolean
  restore(): Promise<void>
}

export async function prepareScreenshotWindow(
  { windowTitle, windowId, applicationPath }: WindowsScreenshotRequest,
  signal: AbortSignal,
): Promise<PreparedScreenshotWindow> {
  signal.throwIfAborted()
  const executable = applicationPath ? await realpath(applicationPath) : undefined
  const allWindows = listScreenshotWindows()
  const windows = allWindows.filter(window => !executable || (window.executable
    && win32.normalize(window.executable).toLowerCase() === win32.normalize(executable).toLowerCase()))
  const selected = findWindowSource(windows, windowTitle, windowId)
  if (!selected && executable && !windows.length) {
    // 启动器可能已退出，不能按文件夹猜测进程归属，也不能重启后让单实例程序抢到前台。
    const candidates = allWindows.filter(window => window.executable
      && win32.basename(window.executable).toLowerCase() === win32.basename(executable).toLowerCase())
    if (candidates.length) throw new Error(`存在同名程序，但进程路径与 application_path 不同；确认后仅用 window_id 选择，或核对启动路径：${candidates.slice(0, 8).map(describeWindowSource).join('、')}`)
    return launchScreenshotApplication(executable, windowTitle!, signal)
  }
  const window = selected ?? selectWindowSource(windows, windowTitle, windowId)
  const id = String(window.handle)
  if (api.visible(window.handle) && !api.minimized(window.handle)) {
    return { id, name: window.name, size: windowSize(window.handle), launched: false, restore: async () => {} }
  }
  const lease = preserveScreenshotWindow(window, false)
  try {
    lease.conceal()
    await showScreenshotWindow(window.handle, signal)
    return { id, name: window.name, size: windowSize(window.handle), launched: false, restore: () => lease.restore() }
  } catch (error) {
    await lease.restore()
    throw error
  }
}
