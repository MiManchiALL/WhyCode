import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  AgentSession,
  getModelEntry,
  MODEL_REGISTRY,
  type CoreCommand,
  type CoreEvent,
} from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
import { getConfigPath, loadConfig } from './config.ts'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
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

function broadcastEvent(event: CoreEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.event, event)
  }
}

/** M1 单窗口单会话：一个全局 session。多会话管理属后续模块。 */
let session: AgentSession | null = null
let currentAbort: AbortController | null = null

function initSession(modelId: string): string | null {
  const config = loadConfig()
  if (!config) {
    return `未找到配置文件 ${getConfigPath()}，请创建并填入 API key（格式见该文件路径旁的文档说明）`
  }
  const entry = getModelEntry(modelId)
  const providerConfig = config.providers[entry.provider]
  if (!providerConfig?.apiKey) {
    return `配置文件缺少 ${entry.provider} 的 apiKey`
  }
  if (session) {
    session.setModel(entry, providerConfig)
  } else {
    session = new AgentSession({
      model: entry,
      providerConfig,
      promptContext: {
        // M1 先以进程工作目录为项目目录；项目选择器属后续 UI 模块
        projectDir: process.cwd(),
        osPlatform: process.platform,
      },
    })
  }
  return null
}

async function handleCommand(command: CoreCommand): Promise<void> {
  switch (command.type) {
    case 'user-message': {
      if (!session) {
        const config = loadConfig()
        const modelId =
          config?.defaultModel ?? MODEL_REGISTRY[0]?.id ?? 'anthropic:claude-sonnet-4-6'
        const err = initSession(modelId)
        if (err) {
          broadcastEvent({ type: 'error', message: err, recoverable: true })
          broadcastEvent({ type: 'agent-status', status: 'idle' })
          return
        }
      }
      currentAbort = new AbortController()
      for await (const event of session!.run(command.text, currentAbort.signal)) {
        broadcastEvent(event)
      }
      currentAbort = null
      break
    }
    case 'abort': {
      currentAbort?.abort()
      break
    }
    case 'set-model': {
      const err = initSession(command.modelId)
      if (err) {
        broadcastEvent({ type: 'error', message: err, recoverable: true })
      }
      break
    }
    case 'approval-response':
      // M1-c 工具审批时实现
      break
  }
}

void app.whenReady().then(() => {
  ipcMain.handle(IPC.command, (_e, command: CoreCommand) => handleCommand(command))
  ipcMain.handle(IPC.listModels, () =>
    MODEL_REGISTRY.map((m) => ({ id: m.id, displayName: m.displayName })),
  )

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
