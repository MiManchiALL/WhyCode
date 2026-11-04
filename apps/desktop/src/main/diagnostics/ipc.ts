import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc.ts'
import type { DiagnosticStore } from './store.ts'
import type { DiagnosticState } from '../../shared/diagnostics.ts'

const rendererDiagnostic = z.object({
  kind: z.enum(['error', 'unhandled-rejection', 'react-render']),
  message: z.string().max(16 * 1024), stack: z.string().max(32 * 1024).optional(),
  componentStack: z.string().max(16 * 1024).optional(),
}).strict()

function requireOwner(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可管理诊断日志')
  return window
}

export function registerDiagnosticIpc(store: DiagnosticStore, notify: (state: DiagnosticState) => void): void {
  store.onChanged = notify
  ipcMain.handle(IPC.diagnosticsState, event => { requireOwner(event); return store.getState() })
  ipcMain.handle(IPC.diagnosticsClear, event => { requireOwner(event); return store.clear() })
  ipcMain.handle(IPC.diagnosticsOpen, async event => {
    requireOwner(event)
    await store.ready
    const error = await shell.openPath(store.files.directory)
    if (error) throw new Error(error)
  })
  ipcMain.handle(IPC.diagnosticsExport, async event => {
    const window = requireOwner(event)
    const result = await dialog.showSaveDialog(window, {
      title: '导出诊断日志', defaultPath: `whycode-diagnostics-${new Date().toISOString().slice(0, 10)}.jsonl.gz`,
      filters: [{ name: '压缩诊断日志', extensions: ['jsonl.gz'] }],
    })
    if (result.canceled || !result.filePath) return false
    await store.export(result.filePath)
    shell.showItemInFolder(result.filePath)
    return true
  })
  ipcMain.on(IPC.rendererDiagnostic, (event, input: unknown) => {
    // send 通道不向网页抛异常；未获授权或无效的上报直接拒绝。
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) return
    const parsed = rendererDiagnostic.safeParse(input)
    if (!parsed.success) return
    store.fault({ level: 'error', source: 'renderer', event: parsed.data.kind,
      details: { webContentsId: event.sender.id, ...parsed.data } })
  })
}
