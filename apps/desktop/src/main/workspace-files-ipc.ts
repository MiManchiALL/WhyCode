import { BrowserWindow, ipcMain, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC } from '../shared/ipc.ts'
import { PREVIEW_SCHEME, type OpenWorkspaceFileRequest, type ReadWorkspaceFileRequest, type WorkspaceFileResult } from '../shared/workspace-files.ts'
import { WorkspaceFiles } from './workspace-files.ts'

export function registerWorkspaceFileIpc(files: WorkspaceFiles, directoryFor: (runtimeId: string) => string): void {
  protocol.handle(PREVIEW_SCHEME, request => files.response(request))
  ipcMain.handle(IPC.openWorkspaceFile, async (event, request: OpenWorkspaceFileRequest): Promise<WorkspaceFileResult> => {
    try {
      const owner = fileWindow(event)
      if (!request || typeof request.runtimeId !== 'string' || !request.runtimeId || typeof request.path !== 'string'
        || !['directory', 'file'].includes(request.kind)) throw new Error('文件浏览请求无效')
      const view = await files.open(owner.id, request, directoryFor(request.runtimeId), id => {
        if (!event.sender.isDestroyed()) event.sender.send(IPC.workspaceFileChanged, { id })
      })
      if (owner.isDestroyed()) { files.close(owner.id, view.id); throw new Error('窗口已关闭') }
      return { ok: true, view }
    } catch (error) { return { ok: false, error: errorMessage(error) } }
  })
  ipcMain.handle(IPC.readWorkspaceFile, async (event, request: ReadWorkspaceFileRequest): Promise<WorkspaceFileResult> => {
    try {
      const owner = fileWindow(event)
      if (!request || typeof request.id !== 'string') throw new Error('文件读取请求无效')
      return { ok: true, view: await files.read(owner.id, request.id, request.offset) }
    } catch (error) { return { ok: false, error: errorMessage(error) } }
  })
  ipcMain.on(IPC.closeWorkspaceFile, (event, id: unknown) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (owner && event.senderFrame === event.sender.mainFrame && typeof id === 'string') files.close(owner.id, id)
  })
  ipcMain.handle(IPC.revealWorkspaceFile, (event, id: unknown) => {
    const owner = fileWindow(event)
    if (typeof id !== 'string') throw new Error('文件路径无效')
    shell.showItemInFolder(files.pathFor(owner.id, id))
  })
}

export function installWorkspaceFileLifecycle(window: BrowserWindow, files: WorkspaceFiles): void {
  const close = () => files.closeOwner(window.id)
  window.webContents.on('did-start-navigation', event => {
    if (event.isMainFrame && !event.isSameDocument) close()
  })
  window.webContents.on('render-process-gone', close)
  window.webContents.once('destroyed', close)
}

function fileWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可浏览工作区')
  return window
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
