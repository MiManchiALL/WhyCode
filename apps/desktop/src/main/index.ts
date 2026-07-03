import { app, BrowserWindow, dialog, ipcMain } from 'electron'
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
/** 当前项目目录；未选择时为 null，发消息前必须先选 */
let projectDir: string | null = null
/** 待用户审批的请求：requestId → resolve */
const pendingApprovals = new Map<string, (approved: boolean) => void>()

function requestApproval(request: {
  requestId: string
  toolName: string
  input: unknown
  diff?: string
}): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(request.requestId, resolve)
    broadcastEvent({ type: 'approval-request', ...request })
  })
}

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
  if (!projectDir) {
    return '请先选择项目目录'
  }
  if (session) {
    session.setModel(entry, providerConfig)
  } else {
    session = new AgentSession({
      model: entry,
      providerConfig,
      promptContext: {
        projectDir,
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
      await session!.run(command.text, currentAbort.signal, broadcastEvent, requestApproval)
      currentAbort = null
      break
    }
    case 'abort': {
      // 中断时把所有挂起的审批一并拒绝，避免 run 永久卡在 await 上
      for (const resolve of pendingApprovals.values()) resolve(false)
      pendingApprovals.clear()
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
    case 'approval-response': {
      const resolve = pendingApprovals.get(command.requestId)
      if (resolve) {
        pendingApprovals.delete(command.requestId)
        resolve(command.approved)
      }
      break
    }
  }
}

void app.whenReady().then(() => {
  ipcMain.handle(IPC.command, (_e, command: CoreCommand) => handleCommand(command))
  ipcMain.handle(IPC.listModels, () =>
    MODEL_REGISTRY.map((m) => ({ id: m.id, displayName: m.displayName })),
  )
  ipcMain.handle(IPC.getProjectDir, () => projectDir)
  ipcMain.handle(IPC.pickProjectDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory'],
    })
    const dir = result.filePaths[0]
    if (!dir) return null
    projectDir = dir
    // 换项目 = 换会话（消息历史与旧项目强相关）
    session = null
    return dir
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
