import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { CoreCommand, CoreEvent } from '@whycode/core'
import { IPC } from '../shared/ipc.ts'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: true,
      contextIsolation: true,
    },
  })

  win.once('ready-to-show', () => win.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

/** 向所有窗口广播 CoreEvent（后续接入 core 的事件出口） */
function broadcastEvent(event: CoreEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.event, event)
  }
}

void app.whenReady().then(() => {
  ipcMain.handle(IPC.command, (_e, command: CoreCommand) => {
    // 骨架阶段：回显命令，验证 IPC 链路。M1-b 接入 Agent loop 后替换。
    if (command.type === 'user-message') {
      broadcastEvent({ type: 'agent-status', status: 'working' })
      broadcastEvent({
        type: 'text-delta',
        text: `【骨架回显】收到消息：${command.text}`,
      })
      broadcastEvent({ type: 'agent-status', status: 'idle' })
    }
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
