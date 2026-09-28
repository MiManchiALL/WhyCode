import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/ipc.ts'
import type { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { TerminalSessions, type TerminalPty } from './terminal-sessions.ts'

export function registerTerminalIpc(
  terminals: TerminalSessions,
  runtimeForId: (runtimeId: string) => DesktopSessionRuntime,
  prepareDirectory: (runtime: DesktopSessionRuntime) => Promise<string>,
  spawnForWorkspace?: (runtime: DesktopSessionRuntime) => ((cwd: string) => Promise<TerminalPty>) | undefined,
): void {
  ipcMain.handle(IPC.createTerminal, (event, runtimeId: unknown) => {
    const window = terminalWindow(event)
    if (!window || typeof runtimeId !== 'string' || !runtimeId) {
      throw new Error('无效的终端请求')
    }
    const runtime = runtimeForId(runtimeId)
    return terminals.create(
      { windowId: window.id, runtimeId, sessionId: runtime.sessionId },
      () => prepareDirectory(runtime),
      (output) => event.sender.send(IPC.terminalEvent, output),
      (terminalId) => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.terminalClosed, terminalId)
      },
      spawnForWorkspace?.(runtime),
    )
  })
  ipcMain.handle(IPC.closeTerminal, (event, terminalId: unknown) => {
    const window = terminalWindow(event)
    if (window && typeof terminalId === 'string') terminals.close(window.id, terminalId)
  })
  ipcMain.on(IPC.terminalControl, (event, control: unknown) => {
    const window = terminalWindow(event)
    if (!window) return
    try {
      terminals.control(window.id, control)
    } catch (error) {
      console.warn('终端操作失败：', error)
    }
  })
}

export function installTerminalWindowLifecycle(window: BrowserWindow, terminals: TerminalSessions): void {
  const close = () => terminals.closeOwner({ windowId: window.id })
  window.webContents.on('did-start-navigation', (event) => {
    if (event.isMainFrame && !event.isSameDocument) close()
  })
  window.webContents.on('render-process-gone', close)
  window.webContents.once('destroyed', close)
}

function terminalWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  if (event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return null
  return BrowserWindow.fromWebContents(event.sender)
}
