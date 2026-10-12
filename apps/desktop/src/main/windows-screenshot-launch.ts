import { realpath, stat } from 'node:fs/promises'
import { dirname, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'
import { describeWindowSource, findWindowSource } from './screenshot-selection.ts'
import type { PreparedScreenshotWindow } from './windows-screenshot-native.ts'
import {
  api, check, kernel32, listScreenshotWindows, preserveScreenshotWindow,
  showScreenshotWindow, user32, waitForWindowState, windowSize,
} from './windows-screenshot-win32.ts'

const eventCallback = koffi.proto('void __stdcall ScreenshotWindowEvent(void *, uint32_t, void *, int32_t, int32_t, uint32_t, uint32_t)')
const startupType = koffi.struct({
  cb: 'uint32_t', reserved: 'void *', desktop: 'void *', title: 'void *',
  x: 'uint32_t', y: 'uint32_t', xSize: 'uint32_t', ySize: 'uint32_t',
  xCount: 'uint32_t', yCount: 'uint32_t', fill: 'uint32_t', flags: 'uint32_t',
  show: 'uint16_t', reservedSize: 'uint16_t', reservedData: 'void *',
  stdin: 'void *', stdout: 'void *', stderr: 'void *', attributes: 'void *',
})
const processType = koffi.struct({ process: 'void *', thread: 'void *', pid: 'uint32_t', threadId: 'uint32_t' })
const pointType = koffi.struct({ x: 'int32_t', y: 'int32_t' })
const launchApi = {
  job: kernel32.func('void * __stdcall CreateJobObjectW(void *, str16)'),
  terminate: kernel32.func('int __stdcall TerminateJobObject(void *, uint32_t)'),
  contains: kernel32.func('int __stdcall IsProcessInJob(void *, void *, _Out_ int *)'),
  initAttributes: kernel32.func('int __stdcall InitializeProcThreadAttributeList(void *, uint32_t, uint32_t, _Inout_ size_t *)'),
  setAttribute: kernel32.func('int __stdcall UpdateProcThreadAttribute(void *, uint32_t, uintptr_t, void *, size_t, void *, void *)'),
  deleteAttributes: kernel32.func('void __stdcall DeleteProcThreadAttributeList(void *)'),
  create: kernel32.func('__stdcall', 'CreateProcessW', 'int', [
    'str16', 'void *', 'void *', 'void *', 'int', 'uint32_t', 'void *', 'str16', koffi.pointer(startupType), koffi.out(koffi.pointer(processType)),
  ]),
  hook: user32.func('__stdcall', 'SetWinEventHook', 'void *', ['uint32_t', 'uint32_t', 'void *', koffi.pointer(eventCallback), 'uint32_t', 'uint32_t', 'uint32_t']),
  unhook: user32.func('int __stdcall UnhookWinEvent(void *)'),
  peek: user32.func('int __stdcall PeekMessageW(void *, void *, uint32_t, uint32_t, uint32_t)'),
  translate: user32.func('int __stdcall TranslateMessage(void *)'),
  dispatch: user32.func('intptr_t __stdcall DispatchMessageW(void *)'),
  lastInput: user32.func('int __stdcall GetLastInputInfo(void *)'),
  foreground: user32.func('int __stdcall SetForegroundWindow(void *)'),
  ancestor: user32.func('void * __stdcall GetAncestor(void *, uint32_t)'),
  desktop: user32.func('void * __stdcall GetDesktopWindow()'),
  key: user32.func('int16_t __stdcall GetAsyncKeyState(int)'),
  cursor: user32.func('__stdcall', 'GetCursorPos', 'int', [koffi.out(koffi.pointer(pointType))]),
  atPoint: user32.func('__stdcall', 'WindowFromPoint', 'void *', [pointType]),
  className: user32.func('int __stdcall GetClassNameW(void *, void *, int)'),
}

export async function launchScreenshotApplication(path: string, title: string, signal: AbortSignal): Promise<PreparedScreenshotWindow> {
  if (!win32.isAbsolute(path) || !/\.exe$/i.test(path)) throw new Error('application_path 必须是 .exe 绝对路径')
  const executable = await realpath(path)
  if (!(await stat(executable)).isFile()) throw new Error('指定的应用程序不存在')
  signal.throwIfAborted()
  const guard = watchApplicationWindows()
  try {
    launchHidden(executable, guard.job)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await delay(100, undefined, { signal })
      guard.check()
      const selected = findWindowSource(listScreenshotWindows(guard.owns), title)
      if (!selected) continue
      guard.protect(selected.handle)
      if (!guard.userSelected(selected.handle)) await showScreenshotWindow(selected.handle, signal)
      await guard.waitForFocus(signal)
      guard.check()
      return { id: String(selected.handle), name: selected.name, size: windowSize(selected.handle), launched: true, restore: guard.restore }
    }
    // 单实例启动器可能只通知已运行的进程；没有归属证据时返回候选身份，不跨进程猜选。
    const candidates = listScreenshotWindows().filter(window => window.name.toLowerCase().includes(title.toLowerCase()))
    throw new Error(`应用已启动，但未出现匹配的自有窗口；请核对窗口标题和启动路径${candidates.length
      ? `；现有候选窗口：${candidates.slice(0, 8).map(describeWindowSource).join('、')}` : ''}`)
  } catch (error) {
    await guard.restore(true)
    throw error
  }
}

function watchApplicationWindows() {
  const job = launchApi.job(null, null) as bigint
  check(job, '建立应用启动范围')
  const windows = new Map<bigint, ReturnType<typeof preserveScreenshotWindow>>()
  const userSelected = new Set<bigint>()
  const hooks: bigint[] = []
  let failure: unknown
  let lastForeground = api.foreground() as bigint | null
  let lastInput = inputTime()
  const owns = (pid: number): boolean => {
    const process = api.openProcess(0x1000, 0, pid)
    if (!process) return false
    try {
      const member = [0]
      return Boolean(launchApi.contains(process, job, member) && member[0])
    } finally { api.close(process) }
  }
  const protect = (handle: bigint) => {
    // WinEvent 也报告 message-only 和子控件窗口，它们不属于可截图的桌面顶层窗口。
    if (!api.exists(handle) || launchApi.ancestor(handle, 1) !== launchApi.desktop()) return
    const pid = [0]
    api.pid(handle, pid)
    if (!owns(pid[0]!)) return
    try {
      let lease = windows.get(handle)
      if (!lease) {
        lease = preserveScreenshotWindow({ handle, pid: pid[0]! }, true)
        windows.set(handle, lease)
      }
      if (!userSelected.has(handle)) lease.conceal()
    } catch (error) {
      // 启动画面可能在事件送达后销毁；消失的窗口不再持有可恢复状态。
      if (api.exists(handle)) throw error
      windows.delete(handle)
    }
  }
  const foregroundChanged = () => {
    const handle = api.foreground() as bigint | null
    if (!handle) return
    const pid = [0]
    api.pid(handle, pid)
    if (!owns(pid[0]!)) {
      lastForeground = handle
      lastInput = inputTime()
    } else if (inputTime() !== lastInput && userIsSelectingWindow(handle) && !userSelected.has(handle)) {
      // 在其它应用打字不等于接管新窗口；只向窗口选择输入让出控制。
      userSelected.add(handle)
      void windows.get(handle)?.restore(true).catch(error => { failure ??= error })
    } else if (!userSelected.has(handle) && lastForeground && api.exists(lastForeground)) {
      // 请求激活不等于切换已完成；在交付窗口前统一等待真实焦点状态。
      launchApi.foreground(lastForeground)
    }
  }
  const callback = koffi.register((_hook: unknown, event: number, handle: bigint, object: number, child: number) => {
    try {
      if (event === 3) foregroundChanged()
      else if (handle && object === 0 && child === 0) {
        if (event === 0x8001) { windows.delete(handle); userSelected.delete(handle) }
        else protect(handle)
      }
    } catch (error) { failure ??= error }
  }, koffi.pointer(eventCallback))
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    clearInterval(timer)
    for (const hook of hooks) launchApi.unhook(hook)
    koffi.unregister(callback)
  }
  try {
    // 启动前监听 CREATE/SHOW，不能等有标题、选中窗口后才处理；启动器子进程同属 job。
    for (const [first, last] of [[3, 3], [0x8000, 0x8002]]) {
      const hook = launchApi.hook(first, last, null, callback, 0, 0, 2) as bigint
      check(hook, '监听应用窗口')
      hooks.push(hook)
    }
    const message = Buffer.alloc(48)
    timer = setInterval(() => {
      try {
        // OUTOFCONTEXT 事件由安装线程的 Windows 消息泵交付；Node 的事件循环不代替它。
        while (launchApi.peek(message, null, 0, 0, 1)) {
          launchApi.translate(message)
          launchApi.dispatch(message)
        }
        foregroundChanged()
      } catch (error) { failure ??= error }
    }, 5)
  } catch (error) {
    stop()
    api.close(job)
    throw error
  }
  return {
    job, owns, protect, userSelected: (handle: bigint) => userSelected.has(handle),
    waitForFocus: (signal: AbortSignal) => waitForWindowState(() => {
      const handle = api.foreground() as bigint | null, pid = [0]
      if (!handle || userSelected.has(handle)) return true
      api.pid(handle, pid)
      return !owns(pid[0]!)
    }, signal, '目标应用主动激活窗口，无法恢复启动前的焦点'),
    check: () => { if (failure) throw failure },
    restore: async (startupFailed = false) => {
      stop()
      try {
        // 尚未显示窗口的自有启动必须结束，否则取消后子进程仍会迟到弹窗。
        if (startupFailed && !userSelected.size
          && !listScreenshotWindows(owns).some(window => api.visible(window.handle))) {
          check(launchApi.terminate(job, 1), '取消未完成的应用启动')
        }
        const results = await Promise.allSettled([...windows].map(([handle, lease]) => lease.restore(userSelected.has(handle))))
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failure) errors.unshift(failure)
        if (errors.length) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join('；'))
      } finally { api.close(job) }
    },
  }
}

function userIsSelectingWindow(handle: bigint): boolean {
  if ([0x12, 0x5b, 0x5c].some(key => launchApi.key(key) & 0x8000)) return true // Alt/Win 窗口切换
  if (!(launchApi.key(1) & 0x8000)) return false
  const point = { x: 0, y: 0 }
  if (!launchApi.cursor(point)) return false
  const clicked = launchApi.ancestor(launchApi.atPoint(point), 2)
  if (clicked === handle) return true
  const buffer = Buffer.alloc(256)
  const length = launchApi.className(clicked, buffer, 128)
  return ['Shell_TrayWnd', 'Shell_SecondaryTrayWnd'].includes(buffer.toString('utf16le', 0, length * 2))
}

function inputTime(): number {
  const info = Buffer.alloc(8)
  info.writeUInt32LE(info.length)
  check(launchApi.lastInput(info), '读取输入状态')
  return info.readUInt32LE(4)
}

function launchHidden(executable: string, job: bigint): void {
  const size = [0]
  launchApi.initAttributes(null, 1, 0, size)
  const attributes = Buffer.alloc(Number(size[0]))
  check(launchApi.initAttributes(attributes, 1, 0, size), '准备启动属性')
  try {
    // 创建时原子关联 job，启动器即使立刻退出，后代身份仍可靠；不使用结束应用的 job 限制。
    const handles = Buffer.alloc(8)
    handles.writeBigUInt64LE(job)
    check(launchApi.setAttribute(attributes, 0, 0x2000d, handles, handles.length, null, null), '关联启动进程树')
    const startup = { cb: koffi.sizeof(startupType), flags: 1 | 0x80, show: 0, attributes }
    const processInfo = { process: null, thread: null, pid: 0, threadId: 0 }
    check(launchApi.create(executable, null, null, null, 0, 0x08080000, null, dirname(executable), startup, processInfo), '后台启动应用')
    api.close(processInfo.thread)
    api.close(processInfo.process)
  } finally { launchApi.deleteAttributes(attributes) }
}
