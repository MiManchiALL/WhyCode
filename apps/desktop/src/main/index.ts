import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentSession,
  cleanupConversationScratch,
  CommandSessionManager,
  ConsensusCoordinator,
  createBackgroundCommandTools,
  getModelEntry,
  importImageAttachments,
  MODEL_REGISTRY,
  type ApprovalRequest,
  type ApprovalResponse,
  type ConsensusAgentSetup,
  type CoreCommand,
  type CoreEvent,
  type AgentStatus,
  type ImageAttachment,
} from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
import {
  consensusAgentsReady,
  getConfigPath,
  loadConfig,
  resolveDefaultModelId,
} from './config.ts'
import { deleteSessionArtifacts } from './session-deletion.ts'
import { DesktopSessionRepository } from './session-repository.ts'
import { routeUserMessage } from './user-message-routing.ts'
import { ViewTimeline } from './view-timeline.ts'
import type {
  DeleteSessionResult,
  ResumeSessionResult,
  RuntimeSnapshot,
  RuntimeEventEnvelope,
  SessionActionResult,
  SessionListItem,
} from '../shared/session.ts'
import {
  registerAttachmentProtocol,
  registerAttachmentScheme,
} from './image-protocol.ts'

registerAttachmentScheme()

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

function broadcastEvent(event: CoreEvent, persistView = true): void {
  if (event.type === 'agent-status') currentAgentStatus = event.status
  if (persistView) viewTimeline.capture(sessions?.journal ?? null, event)
  const envelope: RuntimeEventEnvelope = { sequence: ++runtimeEventSequence, event }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.event, envelope)
  }
}

/** M1 单窗口单会话：一个全局 session。多会话管理属后续模块。 */
let session: AgentSession | null = null
let sessionInitialization: Promise<string | null> | null = null
/** 当前项目目录；未选择时为 null，发消息前必须先选 */
let projectDir: string | null = null
/** 待用户审批的请求：requestId → resolve */
const pendingApprovals = new Map<string, {
  request: ApprovalRequest
  resolve: (response: ApprovalResponse) => void
}>()
/** Renderer 可以重载，权威运行态必须保留在不会随页面消失的主进程。 */
let currentAgentStatus: AgentStatus = 'idle'
let runtimeEventSequence = 0
// --- 多 Agent 协商（M3）---
let consensusEnabled = false
let coordinator: ConsensusCoordinator | null = null
/** 会话级对话 ID（scratch 目录归属；换项目即换对话） */
let conversationId = `conv-${Date.now()}`
/** M4：JSONL 会话仓库；app ready 后用 userData/sessions 初始化 */
let sessions: DesktopSessionRepository
/** 后台命令跨 AgentSession 存活；任务仍按会话 ID 隔离。 */
let commandSessions: CommandSessionManager
/** 会话删除跨多个存储，必须在主进程内单飞并阻止新输入/切换。 */
let sessionDeletionId: string | null = null
/** 图片复制期间拒绝其它输入，避免附件落盘与根消息分类之间发生竞态。 */
let imagePreparationInProgress = false
const viewTimeline = new ViewTimeline((error) => {
  broadcastEvent(
    {
      type: 'error',
      message: `界面历史未能写入会话记录：${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
    },
    false,
  )
})

function requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
  return new Promise((resolve) => {
    pendingApprovals.set(request.requestId, { request: structuredClone(request), resolve })
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
  let entry: ReturnType<typeof getModelEntry>
  try {
    entry = getModelEntry(modelId)
  } catch {
    return `模型 ID 未注册：${modelId}`
  }
  if (!config.providers[entry.provider]?.apiKey) {
    return `尚未配置 ${entry.provider} 的 API key，无法使用 ${entry.displayName}`
  }
  return null
}

/** Main 持有模型选择事实；首次读取时按配置初始化，之后保留用户的会话内选择。 */
function resolveCurrentModelId(): string | null {
  currentModelId ??= resolveDefaultModelId(loadConfig())
  return currentModelId
}

async function ensureSession(): Promise<string | null> {
  const modelId = resolveCurrentModelId()
  if (!modelId) return '没有任何已配置 key 的模型可用'
  const err = validateModel(modelId)
  if (err) return err
  const entry = getModelEntry(modelId)
  const providerConfig = loadConfig()!.providers[entry.provider]!
  if (session) {
    session.setModel(entry, providerConfig)
  } else {
    if (!sessionInitialization) {
      let pending: Promise<string | null>
      pending = (async () => {
        const recorder = await sessions.ensure(projectDir, modelId)
        if (!session) {
          conversationId = recorder.sessionId
          // projectDir 为 null = 纯聊天模式（无工具），core 侧按此适配
          session = new AgentSession({
            model: entry,
            providerConfig,
            promptContext: {
              projectDir,
              osPlatform: process.platform,
              homeDir: app.getPath('home'),
            },
            sessionRecorder: recorder,
            mainTools: createBackgroundCommandTools(commandSessions, recorder.sessionId),
            emit: broadcastEvent,
            requestApproval,
          })
          if (pendingPermissionMode) session.setPermissionMode(pendingPermissionMode)
          coordinator = null // 新会话必须换新协调器（session_score 等按对话重置）
        }
        if (consensusEnabled && !coordinator) return buildCoordinator()
        return null
      })().finally(() => {
        if (sessionInitialization === pending) sessionInitialization = null
      })
      sessionInitialization = pending
    }
    return sessionInitialization
  }
  if (consensusEnabled && !coordinator) {
    const err2 = buildCoordinator()
    if (err2) return err2
  }
  return null
}

/** 协商可用性检查：B/C 评审员配置齐备且模型已注册；纯聊天也允许协商。 */
function checkConsensusReady(): string | null {
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
  const journal = sessions.journal
  if (!journal) return '会话记录尚未初始化，无法启动协商'
  const agents = loadConfig()!.consensusAgents!
  const setup = (id: 'B' | 'C'): ConsensusAgentSetup => ({
    model: getModelEntry(agents[id]!.model),
    providerConfig: { apiKey: agents[id]!.apiKey, baseURL: agents[id]!.baseURL },
  })
  coordinator = new ConsensusCoordinator({
    mainSession: session!,
    projectDir,
    scratchRoot: join(app.getPath('userData'), 'scratch'),
    conversationId,
    agents: { B: setup('B'), C: setup('C') },
    osPlatform: process.platform,
    emit: broadcastEvent,
    requestApproval,
    initialState: journal.initialConsensusState,
    onTaskStart: (taskId, state, userText) =>
      journal.recordConsensusTaskStart(taskId, state, userText),
    onTaskEnd: (taskId, outcome, state) =>
      journal.recordConsensusTaskEnd(taskId, outcome, state),
  })
  return null
}

async function handleCommand(command: CoreCommand): Promise<{ ok: boolean } | void> {
  if (sessionDeletionId) {
    broadcastEvent({
      type: 'error',
      message: '会话数据删除中，请等待完成后再操作',
      recoverable: true,
    })
    return { ok: false }
  }
  switch (command.type) {
    case 'user-message': {
      if (imagePreparationInProgress) {
        return rejectUserMessage('上一条图片消息仍在准备，请稍后重试')
      }
      const attachmentInputs = command.attachments ?? []
      let imageAttachments: ImageAttachment[] = []
      if (attachmentInputs.length > 0) {
        const modelId = resolveCurrentModelId()
        if (!modelId) return rejectUserMessage('没有任何已配置 key 的模型可用')
        const model = getModelEntry(modelId)
        if (!model.capabilities.supportsImageInput) {
          return rejectUserMessage(`${model.displayName} 不支持识图；请切换到带“图片”标记的模型`)
        }
        if (sessionInitialization || session?.isBusy || coordinator?.busy) {
          return rejectUserMessage('图片消息只能在 Agent 空闲时发送，不能排队或立即插话')
        }
        imagePreparationInProgress = true
        let preparationError: string | null = null
        try {
          const err = await ensureSession()
          if (err) throw new Error(err)
          const journal = sessions.journal
          if (!journal) throw new Error('会话记录尚未初始化，无法保存图片')
          imageAttachments = await importImageAttachments(
            attachmentInputs,
            journal.attachmentDirectory,
            journal.sessionId,
          )
        } catch (error) {
          preparationError = `图片添加失败：${error instanceof Error ? error.message : String(error)}`
        } finally {
          imagePreparationInProgress = false
        }
        if (preparationError) return rejectUserMessage(preparationError)
      } else {
        const err = await ensureSession()
        if (err) return rejectUserMessage(err)
      }

      const userText = command.text.trim()
        || (imageAttachments.length ? '请分析这些图片。' : '')
      if (!userText) return rejectUserMessage('消息不能为空')
      await routeUserMessage(userText, command.urgent ?? false, {
        isBusy: runtimeBusy,
        record: (text, startsTurn) => recordUserInput(text, startsTurn, imageAttachments),
        acceptRoot: (text) => {
          broadcastEvent({
            type: 'user-message-accepted',
            text,
            startsTurn: true,
            ...(imageAttachments.length ? { attachments: imageAttachments } : {}),
          }, false)
        },
        deliver: (text, urgent) => {
          if (imageAttachments.length > 0) {
            if (consensusEnabled) {
              broadcastEvent({ type: 'consensus-skipped', reason: 'image-input' })
            }
            return session!.handleUserMessage(text, false, imageAttachments)
          }
          // 协商开启时消息进协调器（Main 探索中仍走会话 steering，B/C 评审中暂存）
          if (consensusEnabled && coordinator) {
            return coordinator.handleUserMessage(text, urgent)
          }
          // 运行中/压缩中 = 排队；空闲 = 新 turn；中止器由 session 自管。
          return session!.handleUserMessage(text, urgent)
        },
      })
      return { ok: true }
    }
    case 'abort': {
      // 中断时把所有挂起的审批一并拒绝，避免 run 永久卡在 await 上
      for (const pending of pendingApprovals.values()) pending.resolve({ approved: false })
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
      return { ok: true }
    }
    case 'restore-checkpoint': {
      if (runtimeBusy()) {
        broadcastEvent({
          type: 'checkpoint-restored',
          toolUseId: command.toolUseId,
          turnId: '',
          scope: command.scope,
          ok: false,
          error: 'Agent 工作中，请等待当前任务结束后再回滚',
        }, false)
        break
      }
      await session?.restoreCheckpoint(command.toolUseId, command.scope)
      break
    }
    case 'compact': {
      if (imagePreparationInProgress) {
        broadcastEvent({
          type: 'error',
          message: '图片消息准备中，请等待提交完成后再压缩',
          recoverable: true,
        })
        return { ok: false }
      }
      if (!session) {
        broadcastEvent({ type: 'error', message: '还没有对话，无需压缩', recoverable: true })
        break
      }
      await session.compactNow()
      break
    }
    case 'set-model': {
      if (imagePreparationInProgress) {
        broadcastEvent({
          type: 'error',
          message: '图片消息准备中，请等待提交完成后再切换模型',
          recoverable: true,
        })
        return { ok: false }
      }
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
        resolve.resolve({ approved: command.approved, remember: command.remember })
      }
      break
    }
  }
}

function runtimeBusy(): boolean {
  return Boolean(
    sessionDeletionId
    || imagePreparationInProgress
    || sessionInitialization
    || session?.isBusy
    || coordinator?.busy,
  )
}

async function recordUserInput(
  text: string,
  startsTurn: boolean,
  attachments: readonly ImageAttachment[] = [],
): Promise<void> {
  try {
    const journal = sessions.journal!
    await journal.recordUserInput(text, startsTurn, attachments)
  } catch (error) {
    broadcastEvent({
      type: 'error',
      message: `用户消息未能写入会话记录：${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
    })
  }
}

function rejectUserMessage(message: string): { ok: false } {
  broadcastEvent({ type: 'error', message, recoverable: true })
  if (!runtimeBusy()) broadcastEvent({ type: 'agent-status', status: 'idle' })
  return { ok: false }
}

function resetRuntime(keepJournal = false): void {
  const oldConversationId = conversationId
  session = null
  sessionInitialization = null
  coordinator = null
  currentAgentStatus = 'idle'
  viewTimeline.discardAll()
  if (!keepJournal) sessions.reset()
  conversationId = `conv-${Date.now()}`
  // 普通运行态切换仍可尽力清临时目录；显式删除会在移除事实源前严格等待清理完成。
  void cleanupConversationScratch(
    join(app.getPath('userData'), 'scratch'),
    oldConversationId,
  ).catch(() => {})
}

function runtimeSnapshot(): RuntimeSnapshot {
  const journal = sessions?.journal ?? null
  const busy = runtimeBusy()
  const checkpointRestoreToolUseId = session?.checkpointRestoreToolUseId ?? null
  return {
    projectDir,
    modelId: resolveCurrentModelId(),
    permissionMode: pendingPermissionMode ?? 'default',
    status: sessionDeletionId
      ? 'working'
      : busy && currentAgentStatus === 'idle' && !checkpointRestoreToolUseId
        ? 'working'
        : currentAgentStatus,
    busy,
    checkpointRestoreToolUseId,
    deletingSessionId: sessionDeletionId,
    viewEvents: journal ? [...journal.initialViewEvents] : [],
    approval: [...pendingApprovals.values()].at(-1)?.request ?? null,
    eventSequence: runtimeEventSequence,
  }
}

async function startNewSession(): Promise<SessionActionResult> {
  if (runtimeBusy()) {
    return {
      ok: false,
      error: sessionDeletionId
        ? '会话数据删除中，请等待完成后再新建会话'
        : session?.checkpointRestoreToolUseId
          ? '文件回滚中，请等待完成后再新建会话'
          : 'Agent 工作中，请先停止再新建会话',
    }
  }
  resetRuntime()
  return { ok: true }
}

async function resumeSession(sessionId: string): Promise<ResumeSessionResult> {
  if (runtimeBusy()) {
    return {
      ok: false,
      error: sessionDeletionId
        ? '会话数据删除中，请等待完成后再恢复会话'
        : session?.checkpointRestoreToolUseId
          ? '文件回滚中，请等待完成后再恢复会话'
          : 'Agent 工作中，请先停止再恢复会话',
    }
  }
  resetRuntime()
  try {
    const journal = await sessions.resume(sessionId)
    const metadata = journal.metadataSnapshot
    const recoveredFromInterruption = Boolean(
      journal.interruptedTurnId
      || journal.undeliveredUserInputIds.length > 0
      || journal.interruptedConsensusTaskId,
    )
    await journal.recoverInterruptedWork()
    projectDir = metadata.projectDir
    currentModelId = !validateModel(metadata.modelId)
      ? metadata.modelId
      : resolveDefaultModelId(loadConfig())
    if (!currentModelId) throw new Error('没有任何已配置 key 的模型可用')
    if (currentModelId !== metadata.modelId) await journal.updateModel(currentModelId)
    conversationId = journal.sessionId
    const error = await ensureSession()
    if (error) throw new Error(error)
    return {
      ok: true,
      session: journal.metadataSnapshot,
      viewEvents: [...journal.initialViewEvents],
      recoveredFromInterruption,
    }
  } catch (error) {
    resetRuntime()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function deleteSession(sessionId: string): Promise<DeleteSessionResult> {
  if (runtimeBusy()) {
    return {
      ok: false,
      error: sessionDeletionId
        ? '已有会话正在删除，请等待完成'
        : session?.checkpointRestoreToolUseId
          ? '文件回滚中，请等待完成后再删除会话'
          : 'Agent 工作中，请先停止再删除会话',
    }
  }
  const deletedCurrent = sessions.currentSessionId === sessionId
  const statusBeforeDeletion = currentAgentStatus
  let detachedCurrent = false
  sessionDeletionId = sessionId
  broadcastEvent({ type: 'agent-status', status: 'working' }, false)
  try {
    const deleted = await deleteSessionArtifacts({
      sessionId,
      sessions,
      commandSessions,
      scratchRoot: join(app.getPath('userData'), 'scratch'),
      onDeletionMarked: () => {
        if (!deletedCurrent) return
        resetRuntime()
        projectDir = null
        detachedCurrent = true
      },
    })
    if (!deleted) return { ok: false, error: '会话不存在', deletedCurrent: detachedCurrent }
    return { ok: true, deletedCurrent }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      deletedCurrent: detachedCurrent || undefined,
    }
  } finally {
    sessionDeletionId = null
    broadcastEvent({
      type: 'agent-status',
      status: detachedCurrent ? 'idle' : statusBeforeDeletion,
    }, false)
  }
}

// userData 中的会话和命令由单一主进程协调；第二实例只能聚焦现有窗口。
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

if (primaryInstance) void app.whenReady().then(async () => {
  // scratch 只服务当次协商；旧命令快照已退出事实源，两者均可在启动时安全清理。
  void Promise.all([
    rm(join(app.getPath('userData'), 'scratch'), { recursive: true, force: true }),
    rm(join(app.getPath('userData'), 'checkpoints'), { recursive: true, force: true }),
  ]).catch(() => {})
  sessions = new DesktopSessionRepository(join(app.getPath('userData'), 'sessions'))
  registerAttachmentProtocol(() => sessions.journal)
  commandSessions = new CommandSessionManager(join(app.getPath('userData'), 'command-tasks'))
  await commandSessions.initialize()
  ipcMain.handle(IPC.command, (_e, command: CoreCommand) => handleCommand(command))
  ipcMain.handle(IPC.listModels, () => {
    const config = loadConfig()
    return MODEL_REGISTRY.map((m) => ({
      id: m.id,
      displayName: m.displayName,
      hasKey: Boolean(config?.providers[m.provider]?.apiKey),
      supportsImageInput: m.capabilities.supportsImageInput,
    }))
  })
  ipcMain.handle(IPC.getProjectDir, () => projectDir)
  ipcMain.handle(IPC.runtimeSnapshot, () => runtimeSnapshot())
  ipcMain.handle(IPC.consensusStatus, () => ({
    ready: checkConsensusReady() === null,
    reason: checkConsensusReady(),
    enabled: consensusEnabled,
  }))
  ipcMain.handle(IPC.listSessions, async (): Promise<SessionListItem[]> => {
    const currentSessionId = sessions.currentSessionId
    return (await sessions.list()).map((item) => ({
      ...item,
      isCurrent: item.sessionId === currentSessionId,
    }))
  })
  ipcMain.handle(IPC.newSession, () => startNewSession())
  ipcMain.handle(IPC.resumeSession, (_e, sessionId: string) => resumeSession(sessionId))
  ipcMain.handle(IPC.deleteSession, (_e, sessionId: string) => deleteSession(sessionId))
  ipcMain.handle(IPC.pickProjectDir, async () => {
    if (runtimeBusy()) {
      broadcastEvent({
        type: 'error',
        message: sessionDeletionId
          ? '会话数据删除中，请等待完成后再切换项目'
          : session?.checkpointRestoreToolUseId
            ? '文件回滚中，请等待完成后再切换项目'
            : 'Agent 工作中，请先停止并等待当前操作结束后再切换项目',
        recoverable: true,
      })
      return null
    }
    const result = await dialog.showOpenDialog({
      title: '选择项目目录',
      properties: ['openDirectory'],
    })
    const dir = result.filePaths[0]
    if (!dir) return null
    // 目录选择框打开期间也可能从其它入口启动任务；提交切换前必须再次权威检查。
    if (runtimeBusy()) {
      broadcastEvent({
        type: 'error',
        message: session?.checkpointRestoreToolUseId
          ? '文件回滚已经开始，项目切换已取消；请等待完成后重试'
          : '当前操作已经开始，项目切换已取消；请停止后重试',
        recoverable: true,
      })
      return null
    }
    projectDir = dir
    // 换项目 = 换会话（消息历史与旧项目强相关）；协商 scratch 随旧对话清理
    resetRuntime()
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

let shutdownStarted = false
app.on('before-quit', (event) => {
  if (shutdownStarted || !commandSessions) return
  event.preventDefault()
  shutdownStarted = true
  void commandSessions
    .shutdown()
    .catch((error) => console.error('后台命令退出清理失败：', error))
    .finally(() => app.quit())
})
