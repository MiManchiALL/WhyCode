import { realpath, stat } from 'node:fs/promises'
import { dirname, join, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'
import { findWindowSource, selectWindowSource } from './screenshot-selection.ts'

const systemDirectory = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const user32 = koffi.load(join(systemDirectory, 'user32.dll'))
const kernel32 = koffi.load(join(systemDirectory, 'kernel32.dll'))
const dwm = koffi.load(join(systemDirectory, 'dwmapi.dll'))
const api = {
  enumerate: user32.func('__stdcall', 'EnumWindows', 'int', [koffi.pointer(koffi.proto('int __stdcall WindowVisitor(void *, intptr_t)')), 'intptr_t']),
  title: user32.func('int __stdcall GetWindowTextW(void *, void *, int)'),
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
  imagePath: kernel32.func('int __stdcall QueryFullProcessImageNameW(void *, uint32_t, void *, _Inout_ uint32_t *)'),
  close: kernel32.func('int __stdcall CloseHandle(void *)'),
  error: kernel32.func('uint32_t __stdcall GetLastError()'),
  clearError: kernel32.func('void __stdcall SetLastError(uint32_t)'),
}
const LAYERED = 0x80000
const TEMPORARY_STYLES = LAYERED | 0x08000000 | 0x20 // NOACTIVATE, TRANSPARENT
const POSITION_FLAGS = 0x4000 | 0x200 | 0x10 | 0x2 | 0x1

export interface NativeScreenshotWindow {
  id: string
  name: string
  display_id: string
  handle: bigint
  pid: number
}

export interface PreparedScreenshotWindow {
  id: string
  name: string
  size: { width: number; height: number }
  launched: boolean
  restore(): Promise<void>
}

export function listScreenshotWindows(): NativeScreenshotWindow[] {
  const windows: NativeScreenshotWindow[] = []
  api.enumerate((handle: bigint) => {
    const title = Buffer.alloc(1024)
    const length = api.title(handle, title, 512)
    if (!length) return 1
    const cloaked = Buffer.alloc(4)
    if (api.attribute(handle, 14, cloaked, cloaked.length) === 0 && cloaked.readUInt32LE()) return 1
    const pid = [0]
    api.pid(handle, pid)
    windows.push({ id: String(handle), name: title.toString('utf16le', 0, length * 2), display_id: '', handle, pid: pid[0]! })
    return 1
  }, 0)
  return windows
}

export async function prepareScreenshotWindow(
  title: string,
  applicationPath: string | undefined,
  signal: AbortSignal,
): Promise<PreparedScreenshotWindow> {
  signal.throwIfAborted()
  const windows = listScreenshotWindows()
  let selected = findWindowSource(windows, title)
  let launched = false
  if (!selected) {
    if (!applicationPath) selectWindowSource(windows, title)
    const executable = await verifiedExecutable(applicationPath!)
    signal.throwIfAborted()
    const pid = launchHidden(executable)
    launched = true
    for (let attempt = 0; attempt < 80 && !selected; attempt++) {
      await delay(100, undefined, { signal })
      selected = findWindowSource(listScreenshotWindows().filter(window =>
        window.pid === pid || processImage(window.pid).toLowerCase() === executable.toLowerCase()), title)
    }
    if (!selected) throw new Error('应用已尝试隐藏启动，但未出现匹配的窗口；请核对窗口标题和主程序路径')
  }
  signal.throwIfAborted()
  if (!launched && api.visible(selected.handle) && !api.minimized(selected.handle)) {
    return { ...selected, size: windowSize(selected.handle), launched, restore: async () => {} }
  }
  return presentWindow(selected, launched, signal)
}

async function presentWindow(window: NativeScreenshotWindow, launched: boolean, signal: AbortSignal): Promise<PreparedScreenshotWindow> {
  const { handle } = window
  if (api.hung(handle)) throw new Error('目标应用没有响应，无法安全恢复窗口用于截图')
  const style = Number(api.style(handle, -20))
  const visible = Boolean(api.visible(handle))
  const minimized = Boolean(api.minimized(handle))
  const previous = api.previous(handle, 3) as bigint | null
  const placement = Buffer.alloc(60)
  placement.writeUInt32LE(placement.length)
  check(api.placement(handle, placement), '读取窗口位置')
  const color = [0], alpha = [255], layerFlags = [2]
  if (style & LAYERED) check(api.layer(handle, color, alpha, layerFlags), '读取窗口透明度')
  const restore = async () => {
    const pid = [0]
    api.pid(handle, pid)
    if (!api.exists(handle) || pid[0] !== window.pid) return
    // 用户主动激活目标后只撤销临时样式，不再隐藏、最小化或重新排列用户窗口。
    const userActivated = api.foreground() === handle
    const errors: unknown[] = []
    try {
      if (!userActivated) {
        if (launched || minimized) {
          const original = Buffer.from(placement)
          original.writeUInt32LE(original.readUInt32LE(4) | 4, 4)
          original.writeUInt32LE(7, 8) // SW_SHOWMINNOACTIVE avoids activation during restoration.
          check(api.setPlacement(handle, original), '还原最小化状态')
          await waitForWindowState(() => Boolean(api.minimized(handle)))
        }
        if (!launched && !visible) {
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
      }
    } catch (error) { errors.push(error) }
    try {
      if (style & LAYERED) check(api.setLayer(handle, color[0], alpha[0], layerFlags[0]), '还原窗口透明度')
      setWindowStyle(handle, (Number(api.style(handle, -20)) & ~TEMPORARY_STYLES) | (style & TEMPORARY_STYLES))
    } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, `窗口状态未能完整还原：${errors.map(error => error instanceof Error ? error.message : String(error)).join('；')}`)
  }
  try {
    setWindowStyle(handle, style | TEMPORARY_STYLES)
    check(api.setLayer(handle, 0, 0, 2), '设置截图期间的透明窗口')
    check(api.position(handle, 1n, 0, 0, 0, 0, POSITION_FLAGS), '设置后台截图层级')
    check(api.show(handle, minimized ? 4 : 8), '后台恢复窗口')
    await waitForWindowState(() => Boolean(api.visible(handle)) && !api.minimized(handle), signal)
    return { id: window.id, name: window.name, size: windowSize(handle), launched, restore }
  } catch (error) {
    await restore()
    throw error
  }
}

function windowSize(handle: bigint): { width: number; height: number } {
  // DWM 边框是物理像素，不受辅助进程的 DPI 感知模式影响。
  const bounds = Buffer.alloc(16)
  check(api.attribute(handle, 9, bounds, bounds.length) === 0, '读取窗口尺寸')
  const width = bounds.readInt32LE(8) - bounds.readInt32LE(0)
  const height = bounds.readInt32LE(12) - bounds.readInt32LE(4)
  if (width <= 0 || height <= 0) throw new Error('目标窗口没有有效的截图尺寸')
  return { width, height }
}

async function waitForWindowState(ready: () => boolean, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(50, undefined, { signal })
    if (ready()) return
  }
  throw new Error('目标应用未完成窗口状态切换')
}

function setWindowStyle(handle: bigint, style: number): void {
  api.clearError(0)
  if (!api.setStyle(handle, -20, style) && api.error()) throw new Error('无法设置窗口截图状态；请检查目标应用权限')
}

function check(result: unknown, operation: string): void {
  if (!result) throw new Error(`${operation}失败（Windows ${api.error()}）`)
}

async function verifiedExecutable(value: string): Promise<string> {
  if (!win32.isAbsolute(value) || !/\.exe$/i.test(value)) throw new Error('application_path 必须是 .exe 绝对路径')
  const executable = await realpath(value)
  if (!(await stat(executable)).isFile()) throw new Error('指定的应用程序不存在')
  return executable
}

function processImage(pid: number): string {
  const handle = api.openProcess(0x1000, 0, pid)
  if (!handle) return ''
  try {
    const buffer = Buffer.alloc(65536), length = [32768]
    return api.imagePath(handle, 0, buffer, length) ? buffer.toString('utf16le', 0, length[0]! * 2) : ''
  } finally { api.close(handle) }
}

function launchHidden(executable: string): number {
  const startupType = koffi.struct({
    cb: 'uint32_t', reserved: 'void *', desktop: 'void *', title: 'void *',
    x: 'uint32_t', y: 'uint32_t', xSize: 'uint32_t', ySize: 'uint32_t',
    xCount: 'uint32_t', yCount: 'uint32_t', fill: 'uint32_t', flags: 'uint32_t',
    show: 'uint16_t', reservedSize: 'uint16_t', reservedData: 'void *',
    stdin: 'void *', stdout: 'void *', stderr: 'void *',
  })
  const processType = koffi.struct({ process: 'void *', thread: 'void *', pid: 'uint32_t', threadId: 'uint32_t' })
  const create = kernel32.func('__stdcall', 'CreateProcessW', 'int', [
    'str16', 'void *', 'void *', 'void *', 'int', 'uint32_t', 'void *', 'str16', koffi.pointer(startupType), koffi.out(koffi.pointer(processType)),
  ])
  const startup = { cb: koffi.sizeof(startupType), flags: 1, show: 0 }
  const processInfo = { process: null, thread: null, pid: 0, threadId: 0 }
  check(create(executable, null, null, null, 0, 0x08000000, null, dirname(executable), startup, processInfo), '隐藏启动应用')
  api.close(processInfo.thread)
  api.close(processInfo.process)
  return processInfo.pid
}
