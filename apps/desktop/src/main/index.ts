import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentSession,
  cleanupConversationScratch,
  ConsensusCoordinator,
  getModelEntry,
  MODEL_REGISTRY,
  type ApprovalRequest,
  type ApprovalResponse,
  type ConsensusAgentSetup,
  type CoreCommand,
  type CoreEvent,
} from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
import { consensusAgentsReady, getConfigPath, loadConfig } from './config.ts'

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

  // 渲染端错误转发到终端：白屏类问题（历史上已 3 次）无 DevTools 也能在 pnpm dev 输出里定位
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] 页面加载失败：${code} ${desc} ${url}`)
  })

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
/** 当前项目目录；未选择时为 null，发消息前必须先选 */
let projectDir: string | null = null
/** 待用户审批的请求：requestId → resolve */
const pendingApprovals = new Map<string, (response: ApprovalResponse) => void>()
// --- 多 Agent 协商（M3）---
let consensusEnabled = false
let coordinator: ConsensusCoordinator | null = null
/** 会话级对话 ID（scratch 目录归属；换项目即换对话） */
let conversationId = `conv-${Date.now()}`

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
    coordinator = null // 新会话必须换新协调器（session_score 等按对话重置）
  }
  if (consensusEnabled && !coordinator) {
    const err2 = buildCoordinator()
    if (err2) return err2
  }
  return null
}

/** 协商可用性检查：B/C 评审员配置齐备 + 模型已注册 + 已选项目目录。返回不可用原因或 null */
function checkConsensusReady(): string | null {
  if (!projectDir) return '协商需要先选择项目目录'
  const config = loadConfig()
  if (!consensusAgentsReady(config)) {
    return '协商需要在配置文件中为评审员 B/C 各配置 model 与 apiKey（consensusAgents 字段）'
  }
  for (const id of ['B', 'C'] as const) {
    try {
      getModelEntry(config!.consensusAgents![id]!.model)
    } catch {
      return `consensusAgents.${id} 的模型 ID 未注册：${config!.consensusAgents![id]!.model}`
    }
  }
  return null
}

function buildCoordinator(): string | null {
  const notReady = checkConsensusReady()
  if (notReady) return notReady
  const agents = loadConfig()!.consensusAgents!
  const setup = (id: 'B' | 'C'): ConsensusAgentSetup => ({
    model: getModelEntry(agents[id]!.model),
    providerConfig: { apiKey: agents[id]!.apiKey, baseURL: agents[id]!.baseURL },
  })
  coordinator = new ConsensusCoordinator({
    mainSession: session!,
    projectDir: projectDir!,
    scratchRoot: join(app.getPath('userData'), 'scratch'),
    conversationId,
    agents: { B: setup('B'), C: setup('C') },
    osPlatform: process.platform,
    emit: broadcastEvent,
    requestApproval,
  })
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
      // 协商开启时消息进协调器（Main 探索中仍走会话 steering，B/C 评审中暂存）
      if (consensusEnabled && coordinator) {
        await coordinator.handleUserMessage(command.text, command.urgent)
      } else {
        // 运行中/压缩中 = 排队（steering）；空闲 = 开新 turn；中止器由 session 自管
        await session!.handleUserMessage(command.text, command.urgent)
      }
      break
    }
    case 'abort': {
      // 中断时把所有挂起的审批一并拒绝，避免 run 永久卡在 await 上
      for (const resolve of pendingApprovals.values()) resolve({ approved: false })
      pendingApprovals.clear()
      coordinator?.abort()
      session?.abort()
      break
    }
    case 'set-consensus': {
      if (!command.enabled) {
        if (coordinator?.busy) {
          broadcastEvent({ type: 'error', message: '协商进行中，请先停止再关闭', recoverable: true })
          return { ok: false }
        }
        consensusEnabled = false
        return { ok: true }
      }
      const notReady = checkConsensusReady()
      if (notReady) {
        broadcastEvent({ type: 'error', message: notReady, recoverable: true })
        return { ok: false }
      }
      consensusEnabled = true
      return { ok: true }
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
      await session.compactNow()
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
  // 上次运行的检查点/协商 scratch 重启后均不可达（回滚索引与对话都在内存），启动时清空防磁盘累积
  for (const dir of ['checkpoints', 'scratch']) {
    void rm(join(app.getPath('userData'), dir), { recursive: true, force: true }).catch(() => {})
  }
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
  ipcMain.handle(IPC.consensusStatus, () => ({
    ready: checkConsensusReady() === null,
    reason: checkConsensusReady(),
    enabled: consensusEnabled,
  }))
  ipcMain.handle(IPC.pickProjectDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory'],
    })
    const dir = result.filePaths[0]
    if (!dir) return null
    projectDir = dir
    // 换项目 = 换会话（消息历史与旧项目强相关）；协商 scratch 随旧对话清理
    session = null
    coordinator = null
    void cleanupConversationScratch(join(app.getPath('userData'), 'scratch'), conversationId)
    conversationId = `conv-${Date.now()}`
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
