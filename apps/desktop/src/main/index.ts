import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  AgentSession,
  getModelEntry,
  MODEL_REGISTRY,
  type ApprovalRequest,
  type ApprovalResponse,
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
const pendingApprovals = new Map<string, (response: ApprovalResponse) => void>()

function requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
  return new Promise((resolve) => {
    pendingApprovals.set(request.requestId, resolve)
    broadcastEvent({ type: 'approval-request', ...request })
  })
}

/** 当前选中的模型（与会话解耦：选目录前也可以切模型） */
let currentModelId: string | null = null
/** 会话创建前用户已选的权限档位（创建时应用） */
let pendingPermissionMode: 'readonly' | 'default' | 'acceptEdits' | 'auto' | null = null

/** 校验模型可用（已注册 + 有 key），返回错误文案或 null */
function validateModel(modelId: string): string | null {
  const config = loadConfig()
  if (!config) {
    return `未找到配置文件 ${getConfigPath()}，请创建并填入 API key（格式见 apps/desktop/src/main/config.ts 注释）`
  }
  const entry = getModelEntry(modelId)
  if (!config.providers[entry.provider]?.apiKey) {
    return `尚未配置 ${entry.provider} 的 API key，无法使用 ${entry.displayName}`
  }
  return null
}

/** 解析默认模型：配置指定的 > 第一个有 key 的 */
function resolveDefaultModelId(): string | null {
  const config = loadConfig()
  if (config?.defaultModel && !validateModel(config.defaultModel)) {
    return config.defaultModel
  }
  return MODEL_REGISTRY.find((m) => !validateModel(m.id))?.id ?? null
}

function ensureSession(): string | null {
  currentModelId ??= resolveDefaultModelId()
  if (!currentModelId) return '没有任何已配置 key 的模型可用'
  const err = validateModel(currentModelId)
  if (err) return err
  const entry = getModelEntry(currentModelId)
  const providerConfig = loadConfig()!.providers[entry.provider]!
  if (session) {
    session.setModel(entry, providerConfig)
  } else {
    // projectDir 为 null = 纯聊天模式（无工具），core 侧按此适配
    session = new AgentSession({
      model: entry,
      providerConfig,
      promptContext: { projectDir, osPlatform: process.platform },
      checkpointStorageDir: join(app.getPath('userData'), 'checkpoints'),
      emit: broadcastEvent,
      requestApproval,
    })
    if (pendingPermissionMode) session.setPermissionMode(pendingPermissionMode)
  }
  return null
}

async function handleCommand(command: CoreCommand): Promise<{ ok: boolean } | void> {
  switch (command.type) {
    case 'user-message': {
      const err = ensureSession()
      if (err) {
        broadcastEvent({ type: 'error', message: err, recoverable: true })
        broadcastEvent({ type: 'agent-status', status: 'idle' })
        return
      }
      if (!session!.isRunning) {
        currentAbort = new AbortController()
      }
      // 运行中 = 排队（steering，urgent 则打断当前步骤立即注入）；空闲 = 开新 turn
      await session!.handleUserMessage(command.text, currentAbort!.signal, command.urgent)
      break
    }
    case 'abort': {
      // 中断时把所有挂起的审批一并拒绝，避免 run 永久卡在 await 上
      for (const resolve of pendingApprovals.values()) resolve({ approved: false })
      pendingApprovals.clear()
      currentAbort?.abort()
      break
    }
    case 'set-permission-mode': {
      session?.setPermissionMode(command.mode)
      pendingPermissionMode = command.mode
      break
    }
    case 'restore-checkpoint': {
      await session?.restoreCheckpoint(command.toolUseId, command.scope)
      break
    }
    case 'compact': {
      if (!session) {
        broadcastEvent({ type: 'error', message: '还没有对话，无需压缩', recoverable: true })
        break
      }
      // 挂到 currentAbort 上：压缩期间「停止」按钮可取消
      currentAbort = new AbortController()
      await session.compactNow(currentAbort.signal)
      currentAbort = null
      break
    }
    case 'set-model': {
      const err = validateModel(command.modelId)
      if (err) {
        broadcastEvent({ type: 'error', message: err, recoverable: true })
        return { ok: false }
      }
      currentModelId = command.modelId
      if (session) {
        const entry = getModelEntry(command.modelId)
        session.setModel(entry, loadConfig()!.providers[entry.provider]!)
      }
      return { ok: true }
    }
    case 'approval-response': {
      const resolve = pendingApprovals.get(command.requestId)
      if (resolve) {
        pendingApprovals.delete(command.requestId)
        resolve({ approved: command.approved, remember: command.remember })
      }
      break
    }
  }
}

void app.whenReady().then(() => {
  ipcMain.handle(IPC.command, (_e, command: CoreCommand) => handleCommand(command))
  ipcMain.handle(IPC.listModels, () => {
    const config = loadConfig()
    return MODEL_REGISTRY.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      hasKey: Boolean(config?.providers[m.provider]?.apiKey),
    }))
  })
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
