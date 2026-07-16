import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AgentSession,
  cleanupUnreferencedAttachments,
  cleanupConversationScratch,
  CommandSessionManager,
  ConsensusCoordinator,
  createBackgroundCommandTools,
  getModelEntry,
  type ApprovalRequest,
  type ApprovalResponse,
  type ConsensusAgentSetup,
  type CoreCommand,
  type CoreEvent,
  type AgentStatus,
  type ImageAttachment,
  type PdfAttachment,
  type SessionJournal,
} from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
import {
  consensusAgentsReady,
  type ConfigSecretCodec,
  getConfigPath,
  loadConfig,
  migratePlaintextSecrets,
  resolveDefaultModelId,
  saveConfig,
} from './config.ts'
import { listModelConnections, resolveModelConnection } from './model-connections.ts'
import {
  createModelSettingsSnapshot,
  deleteCustomConnection,
  testAndUpdateCustomConnection,
  updateProviderSettings,
} from './model-settings.ts'
import { deleteSessionArtifacts } from './session-deletion.ts'
import { DesktopSessionRepository } from './session-repository.ts'
import { routeUserMessage, UserMessageRoutingGate } from './user-message-routing.ts'
import { ViewTimeline } from './view-timeline.ts'
import { captureDesktopScreenshot } from './screenshot-capture.ts'
import { ElectronPdfProcessor } from './pdf/processor.ts'
import { openPdfAttachment } from './pdf/open.ts'
import { ensureDefaultWorkspace } from './workspace.ts'
import {
  prepareUserMessageAttachments as prepareAttachments,
  type PreparedUserMessageAttachments,
  userMessageNeedsAttachmentPreparation,
} from './user-message-attachments.ts'
import type {
  DeleteSessionResult,
  ResumeSessionResult,
  RuntimeSnapshot,
  RuntimeEventEnvelope,
  SessionActionResult,
  SessionListItem,
} from '../shared/session.ts'
import type {
  SaveCustomConnectionRequest,
  SaveProviderSettingsRequest,
  SettingsMutationResult,
} from '../shared/settings.ts'
import {
  registerAttachmentProtocol,
  registerAttachmentScheme,
} from './image-protocol.ts'

registerAttachmentScheme()

const configSecretCodec: ConfigSecretCodec = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (secret) => safeStorage.encryptString(secret).toString('base64'),
  decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
}

function loadAppConfig() {
  return loadConfig(getConfigPath(), configSecretCodec)
}

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
/** 当前工作文件夹；app ready 后始终有值，启动默认目录与用户选择目录共享同一工具语义。 */
let projectDir: string | null = null
let defaultWorkspaceDir: string | null = null
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
/** 会话级对话 ID（scratch 目录归属；换工作文件夹即换对话） */
let conversationId = `conv-${Date.now()}`
/** M4：JSONL 会话仓库；app ready 后用 userData/sessions 初始化 */
let sessions: DesktopSessionRepository
/** 后台命令跨 AgentSession 存活；任务仍按会话 ID 隔离。 */
let commandSessions: CommandSessionManager
/** 会话删除跨多个存储，必须在主进程内单飞并阻止新输入/切换。 */
let sessionDeletionId: string | null = null
/** 附件复制期间拒绝其它输入，避免落盘与根消息分类之间发生竞态。 */
let attachmentPreparationInProgress = false
/** 自定义连接探测期间阻止启动新 Agent 工作，避免模型配置在请求中途切换。 */
let modelSettingsInProgress = false
const pdfProcessor = new ElectronPdfProcessor()
/** JSONL 落盘与 Agent 接收之间的 FIFO 闸门。 */
const userMessageRoutingGate = new UserMessageRoutingGate()
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
  const config = loadAppConfig()
  if (!config) {
    return '尚未配置模型，请打开“模型设置”填写 API key'
  }
  const resolution = resolveModelConnection(config, modelId)
  return resolution.ok ? null : resolution.error
}

/** Main 持有模型选择事实；首次读取时按配置初始化，之后保留用户的会话内选择。 */
function resolveCurrentModelId(): string | null {
  currentModelId ??= resolveDefaultModelId(loadAppConfig())
  return currentModelId
}

async function ensureSession(): Promise<string | null> {
  const modelId = resolveCurrentModelId()
  if (!modelId) return '没有任何已配置 key 的模型可用'
  const err = validateModel(modelId)
  if (err) return err
  const resolved = resolveModelConnection(loadAppConfig(), modelId)
  if (!resolved.ok) return resolved.error
  const { entry, providerConfig } = resolved.value
  if (session) {
    session.setModel(entry, providerConfig)
  } else {
    if (!sessionInitialization) {
      let pending: Promise<string | null>
      pending = (async () => {
        const recorder = await sessions.ensure(projectDir, modelId)
        if (!session) {
          conversationId = recorder.sessionId
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
            captureScreenshot: captureDesktopScreenshot,
            pdfProcessor,
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

/** 协商可用性检查：B/C 评审员配置齐备且模型已注册。 */
function checkConsensusReady(): string | null {
  const config = loadAppConfig()
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
  const agents = loadAppConfig()!.consensusAgents!
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
    onTaskStart: (taskId, state, userText, deliveredInputIds) =>
      journal.recordConsensusTaskStart(taskId, state, userText, deliveredInputIds),
    onTaskEnd: (taskId, outcome, state) =>
      journal.recordConsensusTaskEnd(taskId, outcome, state),
    onInputsRestored: (inputIds) => journal.markUserInputsRestored(inputIds),
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
    case 'user-message':
      return handleUserMessageCommand(command)
    case 'abort': {
      // 中断时把所有挂起的审批一并拒绝，避免 run 永久卡在 await 上
      for (const pending of pendingApprovals.values()) pending.resolve({ approved: false })
      pendingApprovals.clear()
      if (coordinator) await coordinator.abort()
      else session?.abort()
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
      if (attachmentPreparationInProgress) {
        broadcastEvent({
          type: 'error',
          message: '附件消息准备中，请等待提交完成后再压缩',
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
      if (modelSettingsInProgress) {
        broadcastEvent({ type: 'error', message: '模型连接检测中，请稍后再切换模型', recoverable: true })
        return { ok: false }
      }
      if (attachmentPreparationInProgress) {
        broadcastEvent({
          type: 'error',
          message: '附件消息准备中，请等待提交完成后再切换模型',
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
        const resolved = resolveModelConnection(loadAppConfig(), command.modelId)
        if (!resolved.ok) return { ok: false }
        session.setModel(resolved.value.entry, resolved.value.providerConfig)
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

type UserMessageCommand = Extract<CoreCommand, { type: 'user-message' }>

async function prepareUserMessage(
  command: UserMessageCommand,
): Promise<PreparedUserMessageAttachments> {
  if (!userMessageNeedsAttachmentPreparation(command)) {
    const error = await ensureSession()
    if (error) throw new Error(error)
    return {
      attachments: [],
      pdfAttachments: [],
      restoredInputIds: [],
      importedFiles: false,
    }
  }

  const modelId = resolveCurrentModelId()
  if (!modelId) throw new Error('没有任何已配置 key 的模型可用')
  const resolved = resolveModelConnection(loadAppConfig(), modelId)
  if (!resolved.ok) throw new Error(resolved.error)
  const model = resolved.value.entry
  attachmentPreparationInProgress = true
  try {
    const error = await ensureSession()
    if (error) throw new Error(error)
    const journal = sessions.journal
    if (!journal) throw new Error('会话记录尚未初始化，无法保存附件')
    return await prepareAttachments({
      command,
      journal,
      pdfProcessor,
      supportsImageInput: model.capabilities.supportsImageInput,
      modelDisplayName: model.displayName,
      abortSignal: new AbortController().signal,
    })
  } catch (error) {
    throw new Error(`附件添加失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    attachmentPreparationInProgress = false
  }
}

async function handleUserMessageCommand(
  command: UserMessageCommand,
): Promise<{ ok: boolean }> {
  if (modelSettingsInProgress) {
    return rejectUserMessage('模型连接检测中，请等待完成后再发送消息')
  }
  if (attachmentPreparationInProgress) {
    return rejectUserMessage('上一条附件消息仍在准备，请稍后重试')
  }
  let prepared: PreparedUserMessageAttachments
  try {
    prepared = await prepareUserMessage(command)
  } catch (error) {
    return rejectUserMessage(error instanceof Error ? error.message : String(error))
  }

  const userText = command.text.trim()
    || defaultAttachmentPrompt(prepared.attachments, prepared.pdfAttachments)
  if (!userText) return rejectUserMessage('消息不能为空')
  try {
    await routeUserMessage(userText, command.urgent ?? false, {
      isBusy: runtimeBusy,
      reserve: () => userMessageRoutingGate.reserve(),
      record: (inputId, text, startsTurn) => recordUserInput(
        inputId,
        text,
        startsTurn,
        prepared.attachments,
        prepared.restoredInputIds,
        prepared.pdfAttachments,
      ),
      acceptRoot: (text) => broadcastEvent({
        type: 'user-message-accepted',
        text,
        startsTurn: true,
        ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}),
        ...(prepared.pdfAttachments.length ? { pdfAttachments: prepared.pdfAttachments } : {}),
      }, false),
      deliver: (inputId, text, urgent, startsTurn) => deliverUserMessage(
        inputId,
        text,
        urgent,
        startsTurn,
        prepared.attachments,
        prepared.pdfAttachments,
      ),
      onDeliveryError: reportUserMessageDeliveryError,
    })
  } catch (error) {
    const journal = sessions.journal
    if (prepared.importedFiles && journal) {
      await cleanupUnreferencedAttachments(journal.attachmentDirectory, {
        imageAttachments: journal.initialImageAttachments,
        pdfAttachments: journal.initialPdfAttachments,
      }).catch(() => {})
    }
    return rejectUserMessage(
      `用户消息未能安全交付：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return { ok: true }
}

function deliverUserMessage(
  inputId: string,
  text: string,
  urgent: boolean,
  startsTurn: boolean,
  attachments: readonly ImageAttachment[],
  pdfAttachments: readonly PdfAttachment[],
): Promise<unknown> | void {
  const persistedInputId = startsTurn ? undefined : inputId
  if (consensusEnabled && coordinator) {
    return coordinator.handleUserMessage(
      text, urgent, attachments, persistedInputId, pdfAttachments,
    )
  }
  return session!.handleUserMessage(
    text, urgent, attachments, persistedInputId, pdfAttachments,
  )
}

function reportUserMessageDeliveryError(error: unknown): void {
  broadcastEvent({
    type: 'error',
    message: `Agent 接收消息后异常退出：${error instanceof Error ? error.message : String(error)}`,
    recoverable: true,
  })
}

function runtimeBusy(): boolean {
  return Boolean(
    sessionDeletionId
    || attachmentPreparationInProgress
    || modelSettingsInProgress
    || userMessageRoutingGate.busy
    || sessionInitialization
    || session?.isBusy
    || coordinator?.busy,
  )
}

async function persistModelConfig(config: NonNullable<ReturnType<typeof loadAppConfig>>): Promise<void> {
  await saveConfig(config, configSecretCodec, getConfigPath())
  const current = currentModelId
    ? resolveModelConnection(config, currentModelId)
    : null
  currentModelId = current?.ok ? currentModelId : resolveDefaultModelId(config)
  if (!session || !currentModelId) return
  const resolved = resolveModelConnection(config, currentModelId)
  if (resolved.ok) session.setModel(resolved.value.entry, resolved.value.providerConfig)
}

async function saveProviderModelSettings(
  request: SaveProviderSettingsRequest,
): Promise<SettingsMutationResult> {
  if (runtimeBusy()) return { ok: false, error: '当前有操作进行中，请结束后再修改模型设置' }
  modelSettingsInProgress = true
  try {
    const next = updateProviderSettings(loadAppConfig(), request)
    await persistModelConfig(next)
    return { ok: true, snapshot: createModelSettingsSnapshot(next) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    modelSettingsInProgress = false
  }
}

async function saveCustomModelConnection(
  request: SaveCustomConnectionRequest,
): Promise<SettingsMutationResult> {
  if (runtimeBusy()) return { ok: false, error: '当前有操作进行中，请结束后再检测模型连接' }
  modelSettingsInProgress = true
  try {
    const updated = await testAndUpdateCustomConnection(
      loadAppConfig(),
      request,
      new AbortController().signal,
    )
    if (!updated.config) return { ok: false, error: updated.error ?? '连接检测未通过' }
    await persistModelConfig(updated.config)
    return { ok: true, snapshot: createModelSettingsSnapshot(updated.config) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    modelSettingsInProgress = false
  }
}

async function removeCustomModelConnection(
  connectionId: string,
): Promise<SettingsMutationResult> {
  if (runtimeBusy()) return { ok: false, error: '当前有操作进行中，请结束后再删除模型连接' }
  modelSettingsInProgress = true
  try {
    const next = deleteCustomConnection(loadAppConfig(), connectionId)
    await persistModelConfig(next)
    return { ok: true, snapshot: createModelSettingsSnapshot(next) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    modelSettingsInProgress = false
  }
}

async function recordUserInput(
  inputId: string,
  text: string,
  startsTurn: boolean,
  attachments: readonly ImageAttachment[] = [],
  consumesInputIds: readonly string[] = [],
  pdfAttachments: readonly PdfAttachment[] = [],
): Promise<void> {
  const journal = sessions.journal!
  await journal.recordUserInputWithId(
    inputId,
    text,
    startsTurn,
    attachments,
    consumesInputIds,
    pdfAttachments,
  )
}

function defaultAttachmentPrompt(
  images: readonly ImageAttachment[],
  pdfs: readonly PdfAttachment[],
): string {
  if (images.length > 0 && pdfs.length > 0) return '请分析这些附件。'
  if (images.length > 0) return '请分析这些图片。'
  if (pdfs.length > 0) return '请分析这些 PDF。'
  return ''
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
    queuedInputs: journal ? pendingInputs(journal, 'queued') : [],
    restoredInputs: journal ? pendingInputs(journal, 'restored') : [],
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
      || journal.interruptedConsensusTaskId
      || journal.pendingUserInputs.some((input) => input.state === 'queued'),
    )
    await journal.recoverInterruptedWork()
    projectDir = metadata.projectDir ?? requireDefaultWorkspace()
    currentModelId = !validateModel(metadata.modelId)
      ? metadata.modelId
      : resolveDefaultModelId(loadAppConfig())
    if (!currentModelId) throw new Error('没有任何已配置 key 的模型可用')
    if (currentModelId !== metadata.modelId) await journal.updateModel(currentModelId)
    conversationId = journal.sessionId
    const error = await ensureSession()
    if (error) throw new Error(error)
    return {
      ok: true,
      session: { ...journal.metadataSnapshot, projectDir },
      viewEvents: [...journal.initialViewEvents],
      queuedInputs: pendingInputs(journal, 'queued'),
      restoredInputs: pendingInputs(journal, 'restored'),
      recoveredFromInterruption,
    }
  } catch (error) {
    resetRuntime()
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function pendingInputs(
  journal: SessionJournal,
  state: 'queued' | 'restored',
): {
  id: string
  text: string
  attachments?: ImageAttachment[]
  pdfAttachments?: PdfAttachment[]
}[] {
  return journal.pendingUserInputs
    .filter((input) => input.state === state)
    .map((input) => ({
      id: input.id,
      text: input.text,
      ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
      ...(input.pdfAttachments?.length
        ? { pdfAttachments: [...input.pdfAttachments] }
        : {}),
    }))
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
        projectDir = requireDefaultWorkspace()
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
  await migratePlaintextSecrets(configSecretCodec, getConfigPath())
    .catch((error) => console.error('API key 安全迁移失败：', error))
  // scratch 只服务当次协商；旧命令快照已退出事实源，两者均可在启动时安全清理。
  void Promise.all([
    rm(join(app.getPath('userData'), 'scratch'), { recursive: true, force: true }),
    rm(join(app.getPath('userData'), 'checkpoints'), { recursive: true, force: true }),
  ]).catch(() => {})
  try {
    defaultWorkspaceDir = await ensureDefaultWorkspace(
      app.getPath('documents'),
      app.getPath('userData'),
    )
    projectDir = defaultWorkspaceDir
  } catch (error) {
    dialog.showErrorBox(
      'WhyCode 启动失败',
      error instanceof Error ? error.message : '无法创建默认工作文件夹',
    )
    app.quit()
    return
  }
  sessions = new DesktopSessionRepository(
    join(app.getPath('userData'), 'sessions'),
    pdfProcessor,
  )
  registerAttachmentProtocol(() => sessions.journal)
  commandSessions = new CommandSessionManager(join(app.getPath('userData'), 'command-tasks'))
  await commandSessions.initialize()
  ipcMain.handle(IPC.command, (_e, command: CoreCommand) => handleCommand(command))
  ipcMain.handle(IPC.listModels, () => listModelConnections(loadAppConfig()))
  ipcMain.handle(IPC.modelSettings, () => createModelSettingsSnapshot(loadAppConfig()))
  ipcMain.handle(IPC.saveProviderSettings, (_e, request: SaveProviderSettingsRequest) =>
    saveProviderModelSettings(request))
  ipcMain.handle(IPC.saveCustomConnection, (_e, request: SaveCustomConnectionRequest) =>
    saveCustomModelConnection(request))
  ipcMain.handle(IPC.deleteCustomConnection, (_e, connectionId: string) =>
    removeCustomModelConnection(connectionId))
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
  ipcMain.handle(IPC.openPdfAttachment, async (_e, attachmentId: string) => {
    return openPdfAttachment(sessions.journal, attachmentId, (path) => shell.openPath(path))
  })
  ipcMain.handle(IPC.pickProjectDir, async () => {
    if (runtimeBusy()) {
      broadcastEvent({
        type: 'error',
        message: sessionDeletionId
          ? '会话数据删除中，请等待完成后再切换工作文件夹'
          : session?.checkpointRestoreToolUseId
            ? '文件回滚中，请等待完成后再切换工作文件夹'
            : 'Agent 工作中，请先停止并等待当前操作结束后再切换工作文件夹',
        recoverable: true,
      })
      return null
    }
    const result = await dialog.showOpenDialog({
      title: '选择工作文件夹',
      defaultPath: projectDir ?? undefined,
      properties: ['openDirectory'],
    })
    const selected = result.filePaths[0]
    if (!selected) return null
    let dir: string
    try {
      dir = await realpath(selected)
    } catch {
      broadcastEvent({
        type: 'error',
        message: '所选工作文件夹已不可用，请重新选择',
        recoverable: true,
      })
      return null
    }
    // 目录选择框打开期间也可能从其它入口启动任务；提交切换前必须再次权威检查。
    if (runtimeBusy()) {
      broadcastEvent({
        type: 'error',
        message: session?.checkpointRestoreToolUseId
          ? '文件回滚已经开始，工作文件夹切换已取消；请等待完成后重试'
          : '当前操作已经开始，工作文件夹切换已取消；请停止后重试',
        recoverable: true,
      })
      return null
    }
    if (projectDir && samePath(dir, projectDir)) return null
    projectDir = dir
    // 换工作文件夹 = 换会话（消息历史与旧路径强相关）；协商 scratch 随旧对话清理
    resetRuntime()
    return dir
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function requireDefaultWorkspace(): string {
  if (!defaultWorkspaceDir) throw new Error('默认工作文件夹尚未初始化')
  return defaultWorkspaceDir
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

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
