import { realpath, stat } from 'node:fs/promises'
import { dirname, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'
import { describeWindowSource } from './screenshot-selection.ts'
import { api, check, kernel32, listScreenshotWindows, user32, waitForWindowState } from './windows-screenshot-win32.ts'

const eventCallback = koffi.proto('void __stdcall ScreenshotWindowEvent(void *, uint32_t, void *, int32_t, int32_t, uint32_t, uint32_t)')
const startupType = koffi.struct({
  cb: 'uint32_t', reserved: 'void *', desktop: 'void *', title: 'void *',
  x: 'uint32_t', y: 'uint32_t', xSize: 'uint32_t', ySize: 'uint32_t',
  xCount: 'uint32_t', yCount: 'uint32_t', fill: 'uint32_t', flags: 'uint32_t',
  show: 'uint16_t', reservedSize: 'uint16_t', reservedData: 'void *',
  stdin: 'void *', stdout: 'void *', stderr: 'void *', attributes: 'void *',
})
const processType = koffi.struct({ process: 'void *', thread: 'void *', pid: 'uint32_t', threadId: 'uint32_t' })
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
  foreground: user32.func('int __stdcall SetForegroundWindow(void *)'),
  ancestor: user32.func('void * __stdcall GetAncestor(void *, uint32_t)'),
  desktop: user32.func('void * __stdcall GetDesktopWindow()'),
}

export async function launchScreenshotApplication(path: string, signal: AbortSignal): Promise<string> {
  if (!win32.isAbsolute(path) || !/\.exe$/i.test(path)) throw new Error('application_path 必须是 .exe 绝对路径')
  const executable = await realpath(path)
  if (!(await stat(executable)).isFile()) throw new Error('指定的应用程序不存在')
  signal.throwIfAborted()
  const windows = listScreenshotWindows()
  const existing = windows.filter(window => window.executable?.toLowerCase() === executable.toLowerCase())
  if (existing.length) return launchDescription('应用已在运行，本次未重复启动', existing)
  // 启动器与主程序可有不同路径；不凭文件名猜归属，也不重启正在运行的单实例应用。
  const candidates = windows.filter(window => window.executable
    && win32.basename(window.executable).toLowerCase() === win32.basename(executable).toLowerCase())
  if (candidates.length) throw new Error(`存在同名程序，但进程路径与 application_path 不同；确认后仅用 window_id 截图，或核对启动路径：${candidates.slice(0, 8).map(describeWindowSource).join('、')}`)
  const guard = watchApplicationWindows()
  try {
    launchMinimized(executable, guard.job)
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await delay(100, undefined, { signal })
      guard.check()
      const ready = listScreenshotWindows(guard.owns).filter(window => api.visible(window.handle) && api.minimized(window.handle))
      if (!ready.length) continue
      await guard.waitForFocus(signal)
      guard.check()
      return launchDescription('已后台启动应用，窗口保持最小化', ready)
    }
    throw new Error('应用未建立可用的最小化窗口；请核对启动路径')
  } catch (error) {
    // 失败、取消只结束本次创建的进程树，避免未完成的启动在取消后迟到弹窗。
    check(launchApi.terminate(guard.job, 1), '取消未完成的应用启动')
    throw error
  } finally { guard.close() }
}

function launchDescription(status: string, windows: ReturnType<typeof listScreenshotWindows>): string {
  return `${status}，本次未截图。请不带 application_path 再次调用 CaptureScreenshot，按以下候选选择 window_id：${windows.slice(0, 8).map(describeWindowSource).join('、')}`
}

function watchApplicationWindows() {
  const job = launchApi.job(null, null) as bigint
  check(job, '建立应用启动范围')
  const hooks: bigint[] = []
  let failure: unknown
  let lastForeground = api.foreground() as bigint | null
  const owns = (pid: number): boolean => {
    const process = api.openProcess(0x1000, 0, pid)
    if (!process) return false
    try {
      const member = [0]
      return Boolean(launchApi.contains(process, job, member) && member[0])
    } finally { api.close(process) }
  }
  const ownsWindow = (handle: bigint): boolean => {
    const pid = [0]
    return Boolean(api.pid(handle, pid)) && owns(pid[0]!)
  }
  const minimize = (handle: bigint) => {
    if (!api.exists(handle) || launchApi.ancestor(handle, 1) !== launchApi.desktop() || !ownsWindow(handle)) return
    if (api.visible(handle) && !api.minimized(handle)) check(api.show(handle, 7), '保持启动窗口最小化')
  }
  const foregroundChanged = () => {
    const handle = api.foreground() as bigint | null
    if (!handle) return
    if (!ownsWindow(handle)) lastForeground = handle
    else {
      minimize(handle)
      if (lastForeground && api.exists(lastForeground)) launchApi.foreground(lastForeground)
    }
  }
  const callback = koffi.register((_hook: unknown, event: number, handle: bigint, object: number, child: number) => {
    try {
      if (event === 3) foregroundChanged()
      else if (handle && object === 0 && child === 0) minimize(handle)
    } catch (error) { failure ??= error }
  }, koffi.pointer(eventCallback))
  let timer: ReturnType<typeof setInterval> | undefined
  const close = () => {
    clearInterval(timer)
    for (const hook of hooks) launchApi.unhook(hook)
    koffi.unregister(callback)
    api.close(job)
  }
  try {
    // 只观察本次进程树的新窗口；不为启动制造透明窗口、恢复动作或可点击的临时表面。
    for (const event of [3, 0x8002]) {
      const hook = launchApi.hook(event, event, null, callback, 0, 0, 2) as bigint
      check(hook, '监听应用窗口')
      hooks.push(hook)
    }
    const message = Buffer.alloc(48)
    timer = setInterval(() => {
      try {
        while (launchApi.peek(message, null, 0, 0, 1)) {
          launchApi.translate(message)
          launchApi.dispatch(message)
        }
        foregroundChanged()
      } catch (error) { failure ??= error }
    }, 5)
  } catch (error) { close(); throw error }
  return {
    job, owns, close,
    waitForFocus: (signal: AbortSignal) => waitForWindowState(() => {
      const handle = api.foreground() as bigint | null
      return !handle || !ownsWindow(handle)
    }, signal, '目标应用主动激活窗口，无法恢复启动前的焦点'),
    check: () => { if (failure) throw failure },
  }
}

function launchMinimized(executable: string, job: bigint): void {
  const size = [0]
  launchApi.initAttributes(null, 1, 0, size)
  const attributes = Buffer.alloc(Number(size[0]))
  check(launchApi.initAttributes(attributes, 1, 0, size), '准备启动属性')
  try {
    // 创建时原子关联 job，启动器即使立刻退出，后代身份仍可靠。
    const handles = Buffer.alloc(8)
    handles.writeBigUInt64LE(job)
    check(launchApi.setAttribute(attributes, 0, 0x2000d, handles, handles.length, null, null), '关联启动进程树')
    const startup = { cb: koffi.sizeof(startupType), flags: 1 | 0x80, show: 7, attributes }
    const processInfo = { process: null, thread: null, pid: 0, threadId: 0 }
    check(launchApi.create(executable, null, null, null, 0, 0x08080000, null, dirname(executable), startup, processInfo), '后台启动应用')
    api.close(processInfo.thread)
    api.close(processInfo.process)
  } finally { launchApi.deleteAttributes(attributes) }
}
