import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc.ts'

/** 关闭窗口前等待 Renderer 完成草稿事务；失败时留在当前窗口展示保存错误。 */
export function installComposerWindowLifecycle(window: BrowserWindow): void {
  let ready = false
  let pending = false
  let saved = false
  const reset = () => { ready = false; pending = false; saved = false }
  window.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) reset()
  })
  window.webContents.on('render-process-gone', reset)
  window.webContents.on('ipc-message', (event, channel, state: unknown) => {
    if (channel !== IPC.composerPersistence || event.senderFrame !== window.webContents.mainFrame) return
    if (state === 'ready') ready = true
    else if (state === 'unready') reset()
    else if (pending && state === 'saved') {
      pending = false
      saved = true
      window.close()
    } else if (state === 'failed') pending = false
  })
  window.on('close', (event) => {
    if (!ready || saved || window.webContents.isDestroyed()) return
    event.preventDefault()
    if (pending) return
    pending = true
    window.webContents.send(IPC.composerPersistence, 'flush')
  })
}
