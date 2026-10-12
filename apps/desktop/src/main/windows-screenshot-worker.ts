import { prepareScreenshotWindow, type PreparedScreenshotWindow } from './windows-screenshot-native.ts'
import type { WindowsScreenshotRequest } from './windows-screenshot.ts'

const controller = new AbortController()
let release: () => void
const released = new Promise<void>(resolve => { release = resolve })
const cancel = (reason: string) => {
  controller.abort(new Error(reason))
  release()
}
const timeout = setTimeout(() => cancel('应用截图超时'), 20_000)

// 不能直接杀死持有临时窗口状态的进程。宿主退出或取消先触发 finally 还原。
process.on('disconnect', () => cancel('截图宿主已退出'))
process.on('message', message => {
  if ((message as { type?: string })?.type === 'release') release()
  if ((message as { type?: string })?.type === 'cancel') cancel('截图已取消')
})
process.once('message', async message => {
  let prepared: PreparedScreenshotWindow | undefined
  let failure: string | undefined
  try {
    const request = message as WindowsScreenshotRequest & { type: string }
    if (request.type !== 'prepare' || (!request.windowTitle && !request.windowId)) throw new Error('窗口截图请求无效')
    prepared = await prepareScreenshotWindow(request, controller.signal)
    controller.signal.throwIfAborted()
    if (process.connected) process.send?.({ type: 'prepared', id: prepared.id, name: prepared.name, size: prepared.size, launched: prepared.launched })
    await released
    controller.signal.throwIfAborted()
  } catch (error) {
    const reason = controller.signal.aborted && error instanceof Error && error.name === 'AbortError'
      ? controller.signal.reason : error
    failure = reason instanceof Error ? reason.message : String(reason)
  } finally {
    try { await prepared?.restore() }
    catch (error) { failure = `${failure ? `${failure}；` : ''}${error instanceof Error ? error.message : String(error)}` }
    clearTimeout(timeout)
    if (process.connected) {
      process.send?.({ type: 'restored', error: failure }, () => process.disconnect())
    }
  }
})
