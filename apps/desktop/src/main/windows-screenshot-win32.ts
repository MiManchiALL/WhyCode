import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'

const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
export const user32 = koffi.load(join(systemDirectory, 'user32.dll'))
export const kernel32 = koffi.load(join(systemDirectory, 'kernel32.dll'))
const dwm = koffi.load(join(systemDirectory, 'dwmapi.dll'))
export const api = {
  enumerate: user32.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(koffi.proto('int __stdcall WindowVisitor(void *, intptr_t)')), 'intptr_t']),
  title: user32.func('int __stdcall GetWindowTextW(void *, void *, int)'),
  rect: user32.func('int __stdcall GetWindowRect(void *, void *)'),
  pid: user32.func('uint32_t __stdcall GetWindowThreadProcessId(void *, _Out_ uint32_t *)'),
  visible: user32.func('int __stdcall IsWindowVisible(void *)'),
  minimized: user32.func('int __stdcall IsIconic(void *)'),
  exists: user32.func('int __stdcall IsWindow(void *)'),
  hung: user32.func('int __stdcall IsHungAppWindow(void *)'),
  foreground: user32.func('void * __stdcall GetForegroundWindow()'),
  previous: user32.func('void * __stdcall GetWindow(void *, uint32_t)'),
  style: user32.func('intptr_t __stdcall GetWindowLongPtrW(void *, int)'),
  setStyle: user32.func('intptr_t __stdcall SetWindowLongPtrW(void *, int, intptr_t)'),
  placement: user32.func('int __stdcall GetWindowPlacement(void *, void *)'),
  setPlacement: user32.func('int __stdcall SetWindowPlacement(void *, void *)'),
  layer: user32.func('int __stdcall GetLayeredWindowAttributes(void *, _Out_ uint32_t *, _Out_ uint8_t *, _Out_ uint32_t *)'),
  setLayer: user32.func('int __stdcall SetLayeredWindowAttributes(void *, uint32_t, uint8_t, uint32_t)'),
  position: user32.func('int __stdcall SetWindowPos(void *, void *, int, int, int, int, uint32_t)'),
  show: user32.func('int __stdcall ShowWindowAsync(void *, int)'),
  attribute: dwm.func('int __stdcall DwmGetWindowAttribute(void *, uint32_t, void *, uint32_t)'),
  openProcess: kernel32.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
  processPath: kernel32.func('int __stdcall QueryFullProcessImageNameW(void *, uint32_t, void *, _Inout_ uint32_t *)'),
  close: kernel32.func('int __stdcall CloseHandle(void *)'),
  error: kernel32.func('uint32_t __stdcall GetLastError()'),
  clearError: kernel32.func('void __stdcall SetLastError(uint32_t)'),
}
const LAYERED = 0x80000
// NOACTIVATE 会让无 APPWINDOW 样式的窗口退出任务栏管理，最小化后变成桌面图标。
// 透明分层窗口已穿透鼠标；显示和层级操作各自使用不激活标志。
const TEMPORARY_STYLES = LAYERED | 0x20
const POSITION_FLAGS = 0x4000 | 0x200 | 0x10 | 0x2 | 0x1

export interface NativeScreenshotWindow {
  id: string
  name: string
  display_id: string
  handle: bigint
  pid: number
  description: string
  executable?: string
}

export function listScreenshotWindows(owns?: (pid: number) => boolean): NativeScreenshotWindow[] {
  const windows: NativeScreenshotWindow[] = []
  const processes = new Map<number, { included: boolean; executable?: string }>()
  api.enumerate((handle: bigint) => {
    const title = Buffer.alloc(1024)
    const length = api.title(handle, title, 512)
    if (!length) return 1
    const cloaked = Buffer.alloc(4)
    if (api.attribute(handle, 14, cloaked, cloaked.length) === 0 && cloaked.readUInt32LE()) return 1
    const pid = [0]
    api.pid(handle, pid)
    let process = processes.get(pid[0]!)
    if (!process) {
      const included = !owns || owns(pid[0]!)
      process = { included, executable: included ? processExecutable(pid[0]!) : undefined }
      processes.set(pid[0]!, process)
    }
    if (!process.included) return 1
    const { executable } = process
    const bounds = Buffer.alloc(16)
    if (!api.rect(handle, bounds)) return 1
    const width = bounds.readInt32LE(8) - bounds.readInt32LE(0), height = bounds.readInt32LE(12) - bounds.readInt32LE(4)
    if (width <= 1 || height <= 1) return 1
    const state = api.minimized(handle) ? '最小化' : api.visible(handle) ? '已显示' : '隐藏'
    windows.push({
      id: `${handle}:${pid[0]}`, name: title.toString('utf16le', 0, length * 2), display_id: '', handle, pid: pid[0]!, executable,
      description: `${executable ?? `PID ${pid[0]}`}；${state}；${width}×${height}`,
    })
    return 1
  }, 0)
  return windows
}

function processExecutable(pid: number): string | undefined {
  const process = api.openProcess(0x1000, 0, pid)
  if (!process) return undefined
  try {
    const buffer = Buffer.alloc(65_536), length = [buffer.length / 2]
    return api.processPath(process, 0, buffer, length) ? buffer.toString('utf16le', 0, length[0]! * 2) : undefined
  } finally { api.close(process) }
}

export function preserveWindowAppearance(handle: bigint) {
  const pid = [0]
  api.pid(handle, pid)
  const style = Number(api.style(handle, -20))
  const color = [0], alpha = [255], layerFlags = [2]
  if (style & LAYERED) check(api.layer(handle, color, alpha, layerFlags), '读取窗口透明度')
  return {
    conceal: () => {
      setWindowStyle(handle, Number(api.style(handle, -20)) | TEMPORARY_STYLES)
      check(api.setLayer(handle, 0, 0, 2), '设置临时透明窗口')
    },
    restore: () => {
      const currentPid = [0]
      if (!api.exists(handle) || !api.pid(handle, currentPid) || currentPid[0] !== pid[0]) return
      if (style & LAYERED) check(api.setLayer(handle, color[0], alpha[0], layerFlags[0]), '还原窗口透明度')
      setWindowStyle(handle, (Number(api.style(handle, -20)) & ~TEMPORARY_STYLES) | (style & TEMPORARY_STYLES))
    },
  }
}

/** 只借用已有窗口，截图、失败和取消均归还借用前的状态。 */
export function preserveScreenshotWindow(window: Pick<NativeScreenshotWindow, 'handle' | 'pid'>) {
  const { handle } = window
  if (api.hung(handle)) throw new Error('目标应用没有响应，无法安全恢复窗口用于截图')
  const style = Number(api.style(handle, -20))
  const visible = Boolean(api.visible(handle))
  const minimized = Boolean(api.minimized(handle))
  const previous = api.previous(handle, 3) as bigint | null
  const placement = Buffer.alloc(60)
  placement.writeUInt32LE(placement.length)
  check(api.placement(handle, placement), '读取窗口位置')
  const appearance = preserveWindowAppearance(handle)
  const restore = async () => {
    const pid = [0]
    api.pid(handle, pid)
    if (!api.exists(handle) || pid[0] !== window.pid) return
    const errors: unknown[] = []
    try {
      if (minimized) {
        const original = Buffer.from(placement)
        original.writeUInt32LE(original.readUInt32LE(4) | 4, 4)
        original.writeUInt32LE(7, 8) // SW_SHOWMINNOACTIVE avoids activation during restoration.
        check(api.setPlacement(handle, original), '还原最小化状态')
        await waitForWindowState(() => Boolean(api.minimized(handle)))
      }
      if (!visible) {
        check(api.show(handle, 0), '还原隐藏状态')
        await waitForWindowState(() => !api.visible(handle))
      }
      if (style & 8) check(api.position(handle, -1n, 0, 0, 0, 0, POSITION_FLAGS), '还原置顶状态')
      if (!previous || api.exists(previous)) {
        // 跟在置顶窗口后调用 SetWindowPos 会改变所属层；普通窗口应回到普通层顶部。
        const insertAfter = !(style & 8) && previous && (Number(api.style(previous, -20)) & 8) ? null : previous
        check(api.position(handle, insertAfter, 0, 0, 0, 0, POSITION_FLAGS), '还原窗口层级')
        await waitForWindowState(() => api.previous(handle, 3) === previous && (Number(api.style(handle, -20)) & 8) === (style & 8))
      }
    } catch (error) { errors.push(error) }
    try { appearance.restore() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, `窗口状态未能完整还原：${errors.map(error => error instanceof Error ? error.message : String(error)).join('；')}`)
  }
  return { conceal: appearance.conceal, restore }
}

export async function showScreenshotWindow(handle: bigint, signal: AbortSignal): Promise<void> {
  if (api.hung(handle)) throw new Error('目标应用没有响应，无法安全恢复窗口用于截图')
  check(api.position(handle, 1n, 0, 0, 0, 0, POSITION_FLAGS), '设置后台截图层级')
  check(api.show(handle, api.minimized(handle) ? 4 : 8), '后台恢复窗口')
  await waitForWindowState(() => Boolean(api.visible(handle)) && !api.minimized(handle), signal)
}

export function windowSize(handle: bigint): { width: number; height: number } {
  // DWM 边框是物理像素，不受辅助进程的 DPI 感知模式影响。
  const bounds = Buffer.alloc(16)
  check(api.attribute(handle, 9, bounds, bounds.length) === 0, '读取窗口尺寸')
  const width = bounds.readInt32LE(8) - bounds.readInt32LE(0)
  const height = bounds.readInt32LE(12) - bounds.readInt32LE(4)
  if (width <= 0 || height <= 0) throw new Error('目标窗口没有有效的截图尺寸')
  return { width, height }
}

export async function waitForWindowState(ready: () => boolean, signal?: AbortSignal, message = '目标应用未完成窗口状态切换'): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(50, undefined, { signal })
    if (ready()) return
  }
  throw new Error(message)
}

function setWindowStyle(handle: bigint, style: number): void {
  api.clearError(0)
  if (!api.setStyle(handle, -20, style) && api.error()) throw new Error('无法设置窗口截图状态；请检查目标应用权限')
}

export function check(result: unknown, operation: string): void {
  if (!result) throw new Error(`${operation}失败（Windows ${api.error()}）`)
}
