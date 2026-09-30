import { SshConnectionStore } from './ssh/store.ts'
import { SshConnections } from './ssh/connections.ts'
import { SshScratchCleanupError, SshWorkspaces, sshScratchPaths } from './ssh/workspaces.ts'
import { registerSshIpc } from './ssh/ipc.ts'
import { WorkspaceLifecycle } from './workspace-lifecycle.ts'
import { registerWorkspaceLifecycleIpc } from './workspace-lifecycle-ipc.ts'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  MessageChannelMain,
  net,
  protocol,
  safeStorage,
  shell,
  type WebContents,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { createSiteIconHandler } from './site-icon.ts'
import { SITE_ICON_SCHEME } from '../shared/site-icon.ts'
import { rm } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import {
  AgentSession,
  type BackgroundTaskState,
  BUILTIN_TOOLS,
  cleanupUnreferencedAttachments,
  compactVisibleCoreEvent,
  CommandSessionManager,
  ConsensusCoordinator,
  createCommandTools,
  createAuxiliaryImageAnalyzer,
  createBuildOfficeArtifactTool,
  createInspectOfficeTool,
  createWebFetchTool,
  createWebFindTool,
  createWebSearchTool,
  ensureMcpConfigTemplate,
  ensureProjectMcpConfigTemplate,
  installSystemSkills,
  inspectLatestTurnEdit,
  loadMcpConfiguration,
  McpSessionRuntime,
  normalizeReasoningEffortSelection,
  prepareImageAttachmentImport,
  type BtwTurnContext,
  type CoreCommand,
  type CoreEvent,
  type ImageAttachment,
  type ImageDeliveryMode,
  type ImageAttachmentInput,
  type ModelEntry,
  type PdfAttachment,
  type ProviderConfig,
  type ReasoningEffortSelection,
  RUN_COMMAND_TOOL_NAME,
  USER_IMAGE_ATTACHMENT_MAX_COUNT,
  type SessionJournal,
  SkillCatalogService,
  SubagentDefinitionCatalogService,
  skillSummary,
  type ActivatedSkill,
  type SubagentEventEnvelope,
  type SubagentModelSnapshot,
  type SubagentSettlementNotification,
  type SubagentState,
  type WorkspaceBinding,
  type WorktreeWorkspaceBinding,
  validateSessionId,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'
import { conversationHistoryWindow } from './conversation-history.ts'
import { synchronizeRuntimeModelSelection } from './runtime-model-selection.ts'
import {
  checkCheckpointFileCurrentMatch,
  readCheckpointFileChanges,
  readCheckpointFilePreview,
} from './checkpoint-history.ts'
import { createConversationState } from '../shared/conversation-state.ts'
import type { ConversationHistoryRequest, ConversationHistoryResult } from '../shared/conversation-history.ts'
import { IPC } from '../shared/ipc.ts'
import { attachmentFallbackText } from '../shared/user-message.ts'
import {
  type ConfigSecretCodec,
  getConfigPath,
  loadConfig,
  migrateLegacyConfig,
  resolveDefaultModelId,
  saveConfig,
  ConfigReadError,
  type WhycodeConfig,
} from './config.ts'
import {
  imageInputModeForModel,
  listModelConnections,
  pruneInvalidAuxiliaryModels,
  pruneInvalidConsensusAgents,
  resolveAuxiliaryVisionModel,
  resolveModelConnection,
  resolveSubagentModelSelection,
} from './model-connections.ts'
import { resolveConsensusAgentSetups } from './consensus-models.ts'
import {
  discoverCliProxyRoutes,
  createCliProxyRouteSynchronizer,
} from './cli-proxy-discovery.ts'
import {
  createConnectionSettingsSnapshot,
  updateAuxiliaryModelSettings,
  updateCliProxyApiSettings,
  updateConsensusModelSettings,
  updateProviderSettings,
} from './model-settings.ts'
import {
  addMcpConfiguredServer,
  createMcpSettingsSnapshot,
  createMcpStatusSnapshot,
  resolveMcpConfigPath,
  updateMcpSecretHeader,
  updateMcpServerState,
} from './mcp-settings.ts'
import { stageSessionDeletion } from './session-deletion.ts'
import { SessionScratchManager } from './session-scratch.ts'
import { NewSessionStateStore } from './new-session-state.ts'
import { installComposerWindowLifecycle } from './composer-window-lifecycle.ts'
import { TerminalSessions } from './terminal-sessions.ts'
import { installTerminalWindowLifecycle, registerTerminalIpc } from './terminal-ipc.ts'
import { WorkspaceFiles } from './workspace-files.ts'
import { installWorkspaceFileLifecycle, registerWorkspaceFileIpc } from './workspace-files-ipc.ts'
import { runtimeWorkspaceBinding, workspaceDisplayDirectory, workspaceProjectDirectory } from '../shared/workspace.ts'
import { SessionDeletionLock } from './session-deletion-lock.ts'
import { DesktopSessionRepository } from './session-repository.ts'
import { SessionPreparationLock } from './session-preparation-lock.ts'
import { SessionNavigation } from './session-navigation.ts'
import {
  ensureCustomSystemPromptTemplate,
  getCustomSystemPromptConfigPath,
  loadCustomSystemPromptSnapshot,
} from './custom-system-prompt.ts'
import { syncReferencedRetiredModelLabels } from './retired-model-labels.ts'
import { routeUserMessage } from './user-message-routing.ts'
import { deliverEditedUserMessage, startEditedUserMessage } from './user-message-edit.ts'
import { prepareMessageSkills } from './skill-message.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import {
  MAX_CONCURRENT_AGENT_RUNS,
  SessionRuntimeRegistry,
} from './session-runtime-registry.ts'
import {
  BackgroundTaskWakeQueue,
  type BackgroundTaskRuntimeResolution,
} from './background-task-wakeup.ts'
import { SessionNotificationWakeQueue } from './session-notification-wakeup.ts'
import { SubagentService } from './subagent-service.ts'
import { HostOperationScheduler } from './host-operation-scheduler.ts'
import { captureDesktopScreenshot } from './screenshot-capture.ts'
import { ElectronPdfProcessor } from './pdf/processor.ts'
import { ElectronOfficeArtifactRunner } from './office/builder.ts'
import { ElectronOfficeProcessor } from './office/processor.ts'
import { openPdfAttachment } from './pdf/open.ts'
import { ensureDefaultWorkspace, ManagedWorkspaceManager } from './workspace.ts'
import {
  prepareUserMessageAttachments as prepareAttachments,
  type PreparedUserMessageAttachments,
  userMessageNeedsAttachmentPreparation,
} from './user-message-attachments.ts'
import type {
  CheckpointFileChangesRequest,
  CheckpointFileChangesResult,
  CheckpointFileCurrentMatchRequest,
  CheckpointFileCurrentMatchResult,
  CheckpointFilePreviewRequest,
  CheckpointFilePreviewResult,
  DeleteSessionResult,
  DeleteSessionOptions,
  ForkSessionRequest,
  ForkSessionResult,
  NewSessionRequest,
  NewSessionResult,
  ResumeSessionResult,
  RuntimeSnapshot,
  RuntimeEventBatch,
  RuntimeEventEnvelope,
  RuntimeCommandEnvelope,
  RuntimeCommandResult,
  SessionDeletionState,
  SetSessionPinnedRequest,
  SetSessionPinnedResult,
} from '../shared/session.ts'
import type {
  RuntimeWorkspace,
  WorkspaceActionResult,
  WorkspaceCandidate,
  WorktreeStatus,
} from '../shared/workspace.ts'
import {
  materializeRuntimeWorkspace,
  prepareDefaultRuntimeWorkspace,
  restoreSubmittedWorkspace,
  prepareRuntimeWorkspace,
} from './runtime-workspace.ts'
import { canonicalDirectory } from './managed-worktree-registry.ts'
import type {
  AddMcpServerRequest,
  ConnectionSettingsSnapshot,
  McpOAuthRequest,
  OpenMcpConfigRequest,
  SaveAuxiliaryModelSettingsRequest,
  SaveCliProxyApiSettingsRequest,
  SaveConsensusModelSettingsRequest,
  SaveProviderSettingsRequest,
  SaveMcpSecretHeaderRequest,
  SaveWebSearchSettingsRequest,
  SetMcpServerEnabledRequest,
  SettingsMutationResult,
} from '../shared/settings.ts'
import {
  McpOAuthController,
  type McpRegisteredOAuthClient,
} from './mcp-oauth.ts'
import { createConfiguredWebSearchHandler } from './web-search/configured.ts'
import { updateWebSearchSettings } from './web-search-settings.ts'
import {
  createElectronWebHostResolver,
  createElectronWebPageFetch,
} from './web-page/electron-fetch.ts'
import { createWebDocumentFetcher } from './web-page/network.ts'
import { createWebPageReader } from './web-page/reader.ts'
import {
  extractWebTextDocument,
} from './web-page/processor.ts'
import { importWebPdfDocument } from './web-page/pdf-import.ts'
import { installExternalWebLinkHandlers } from './external-link.ts'
import { installImageContextMenu } from './image-context-menu.ts'
import { createRendererCrashRecoveryController } from './renderer-crash-recovery.ts'
import { RuntimeEventBatcher } from './runtime-event-batcher.ts'
import { isBackgroundRuntimeLifecycleEvent } from './runtime-event-delivery.ts'
import { RuntimeEventPortHub } from './runtime-event-port-hub.ts'
import { WorktreeManager } from './worktree-manager.ts'
import { projectSessionListItems } from './session-list.ts'
import { SessionSidebarStateStore } from './session-sidebar-state.ts'
import { ProjectStore } from './project-store.ts'
import type { SessionSidebarSnapshot } from '../shared/projects.ts'
import type { RenameSessionRequest, RenameSessionResult } from '../shared/session-name.ts'
import {
  registerAttachmentProtocol,
  registerFileSchemes,
} from './image-protocol.ts'

registerFileSchemes()
const workspaceFiles = new WorkspaceFiles()

const configSecretCodec: ConfigSecretCodec = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (secret) => safeStorage.encryptString(secret).toString('base64'),
  decrypt: (payload) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
}

const customSystemPromptConfigPath = getCustomSystemPromptConfigPath(getConfigPath())
const mcpGlobalConfigPath = join(dirname(getConfigPath()), 'mcp.json')

function loadAppConfig() {
  return loadConfig(getConfigPath(), configSecretCodec)
}

function loadDisplayConfig() {
  try {
    return loadAppConfig()
  } catch (error) {
    if (!(error instanceof ConfigReadError)) throw error
    // 配置故障不阻止查看历史；连接读取、实际请求和所有写入仍由严格入口报错。
    return null
  }
}

let runtimePreferenceWriteTail: Promise<void> = Promise.resolve()

function persistRuntimePreferences(
  patch: Partial<Pick<WhycodeConfig, 'defaultModel' | 'permissionMode'>>,
  excludedSessionId?: string,
): Promise<void> {
  // 偏好和历史显示名共用一条读改写链，避免多窗口选择与会话删除互相覆盖配置。
  const write = runtimePreferenceWriteTail.then(async () => {
    const referencedModelIds = new Set((await sessions.list())
      .filter((summary) => summary.sessionId !== excludedSessionId)
      .flatMap((summary) => summary.referencedModelIds))
    const config = loadAppConfig() ?? { providers: {} }
    const next = syncReferencedRetiredModelLabels(
      Object.keys(patch).length ? { ...config, ...patch } : config,
      referencedModelIds,
    )
    if (next !== config) await saveConfig(next, configSecretCodec, getConfigPath())
  })
  runtimePreferenceWriteTail = write.catch(() => {})
  return write
}

function persistPermissionMode(mode: PermissionMode): Promise<void> {
  return persistRuntimePreferences({ permissionMode: mode })
}

function persistPreferredModel(modelId: string): Promise<void> {
  return persistRuntimePreferences({ defaultModel: modelId })
}

const mcpOAuthController = new McpOAuthController({
  fetchImpl: (input, init) => net.fetch(
    input instanceof URL ? input.toString() : input,
    init,
  ),
  openExternal: (url) => shell.openExternal(url),
  readSessions: () => loadAppConfig()?.mcpOAuthSessions ?? [],
  writeSessions: persistMcpOAuthSessions,
  registeredClients: {
    ...githubOAuthClientFromEnvironment(),
  },
})

const webSearchTool = createWebSearchTool({
  search: createConfiguredWebSearchHandler({
    getConfig: loadAppConfig,
    // Chromium 网络栈继承系统代理；Node fetch 会绕过 Windows 代理设置。
    fetchImpl: (input, init) => net.fetch(input, init),
  }),
})

function createSessionWebPageTools(recorder: SessionJournal) {
  const fetchImpl = createElectronWebPageFetch((options) => net.request(options))
  const fetchDocument = createWebDocumentFetcher({
    fetchImpl,
    // 预检与实际请求共用 Chromium 的解析缓存和网络栈；重定向仍逐跳重新校验。
    resolveHost: createElectronWebHostResolver((hostname, options) =>
      net.resolveHost(hostname, options)),
  })
  const reader = createWebPageReader({
    fetchDocument,
    extractDocument: extractWebTextDocument,
    importPdfDocument: (document, abortSignal) => importWebPdfDocument(
      document,
      {
        attachmentDirectory: recorder.attachmentDirectory,
        sessionId: recorder.sessionId,
        processor: pdfProcessor,
      },
      abortSignal,
    ),
  })
  return [
    createWebFetchTool({ fetchPage: reader.fetchPage }),
    createWebFindTool({ findInPage: reader.findInPage }),
  ]
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
  installTerminalWindowLifecycle(win, terminals)
  installWorkspaceFileLifecycle(win, workspaceFiles)
  installImageContextMenu(win)
  installComposerWindowLifecycle(win)

  installExternalWebLinkHandlers(
    win,
    (url) => shell.openExternal(url),
    (error) => console.error(
      `[external-link] 无法打开来源链接：${error instanceof Error ? error.message : String(error)}`,
    ),
  )

  // 渲染端错误转发到终端：白屏类问题（历史上已 3 次）无 DevTools 也能在 pnpm dev 输出里定位
  win.webContents.on('console-message', (event) => {
    if (event.level === 'error') {
      console.error(`[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`)
    }
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] 页面加载失败：${code} ${desc} ${url}`)
  })
  const rendererRecovery = createRendererCrashRecoveryController({
    isShuttingDown: () => shutdownStarted,
    isUnavailable: () => win.isDestroyed() || win.webContents.isDestroyed(),
    reload: () => win.webContents.reload(),
  })
  win.webContents.on('did-finish-load', () => rendererRecovery.rendererLoaded())
  win.webContents.on('render-process-gone', (_event, details) => {
    const recoveryScheduled = rendererRecovery.rendererGone(details)
    console.error(
      `[renderer] 渲染进程退出：reason=${details.reason} exitCode=${details.exitCode}; `
      + (recoveryScheduled ? '已安排从运行时快照恢复' : '未安排恢复'),
    )
  })
  const webContentsId = win.webContents.id
  win.webContents.once('destroyed', () => runtimeEventPorts.detach(webContentsId))

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

function broadcastRuntimeEvent(
  runtime: DesktopSessionRuntime,
  event: CoreEvent,
  occurredAt: string,
): void {
  if (event.type === 'work-finished') runtimeRegistry.markWorkFinished(runtime)
  const sequence = ++runtimeEventSequence
  if (
    runtimeRegistry.selected === runtime
    || isBackgroundRuntimeLifecycleEvent(event)
  ) {
    const envelope: RuntimeEventEnvelope = {
      runtimeId: runtime.runtimeId,
      sessionId: runtime.sessionId,
      sequence,
      occurredAt,
      event: compactVisibleCoreEvent(event),
    }
    runtimeEventBatcher.push(envelope)
  }
  if (
    event.type === 'agent-status'
    && (event.status === 'idle' || event.status === 'error')
  ) {
    runtimeRegistry.runtimeBecameIdle(runtime)
    nudgeNotificationQueues()
  }
}

function publishRuntimeEventBatch(events: RuntimeEventBatch): void {
  runtimeEventPorts.publish(events)
}

function provideRuntimeEventPort(sender: WebContents): void {
  const owner = BrowserWindow.fromWebContents(sender)
  if (!owner || owner.isDestroyed() || sender.isDestroyed()) return
  const channel = new MessageChannelMain()
  try {
    runtimeEventPorts.attach(sender.id, channel.port2)
    sender.postMessage(IPC.runtimeEventPort, null, [channel.port1])
  } catch (error) {
    runtimeEventPorts.detach(sender.id)
    channel.port1.close()
    console.warn('运行时事件端口创建失败：', error)
  }
}

function broadcastBackgroundTasks(state: BackgroundTaskState): void {
  broadcastToWindows(IPC.backgroundTasks, state, '后台任务状态推送失败：')
}

function broadcastSessionDeletion(state: SessionDeletionState): void {
  broadcastToWindows(IPC.sessionDeletion, state, '会话删除状态推送失败：')
}

function broadcastSubagents(state: SubagentState): void {
  broadcastToWindows(IPC.subagents, state, '子代理状态推送失败：')
}

function broadcastSubagentEvent(envelope: SubagentEventEnvelope): void {
  broadcastToWindows(IPC.subagentEvent, envelope, '子代理事件推送失败：')
}

function broadcastToWindows(channel: string, payload: unknown, failureMessage: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(channel, payload)
    } catch (error) {
      console.warn(failureMessage, error)
    }
  }
}

function nudgeNotificationQueues(): void {
  void backgroundTaskWakeups?.nudge()
  void subagentWakeups?.nudge()
}

/** 当前工作文件夹；app ready 后始终有值，启动默认目录与用户选择目录共享同一工具语义。 */
let defaultWorkspaceDir: string | null = null
/** Renderer 可以重载，权威运行态必须保留在不会随页面消失的主进程。 */
let runtimeEventSequence = 0
const runtimeEventPorts = new RuntimeEventPortHub({
  onPublishError: (error) => console.warn('运行时事件端口推送失败：', error),
})
const runtimeEventBatcher = new RuntimeEventBatcher({
  publish: publishRuntimeEventBatch,
})
// --- 多 Agent 协商（M3）---
/** M4：JSONL 会话仓库；app ready 后用 userData/sessions 初始化 */
let sessions: DesktopSessionRepository
let runtimeRegistry!: SessionRuntimeRegistry
let sessionSidebarState: SessionSidebarStateStore
let projects: ProjectStore
/** 后台命令跨 AgentSession 存活；任务仍按会话 ID 隔离。 */
let commandSessions: CommandSessionManager
/** 后台命令终态的内部通知队列；只负责调度，模型消息仍由 AgentSession 持久化。 */
let backgroundTaskWakeups: BackgroundTaskWakeQueue | null = null
/** 子代理终态的持久化唤醒队列；完整结果由子会话保存，队列只持有有界通知。 */
let subagentWakeups: SessionNotificationWakeQueue<SubagentSettlementNotification> | null = null
/** 子代理定义目录与运行时服务均由主进程单例持有。 */
let subagentDefinitions: SubagentDefinitionCatalogService
let subagents: SubagentService
/** WhyCode 受管 Git Worktree 的创建、所有权、恢复校验与清理事实源。 */
let worktrees: WorktreeManager
/** 新会话创建受管目录；Fork 共享项目目录，各自持有独立引用。 */
let managedWorkspaces: ManagedWorkspaceManager
let workspaceLifecycle: WorkspaceLifecycle
let newSessionState: NewSessionStateStore
let sshWorkspaces: SshWorkspaces
/** 普通 Main 与协商任务共用的会话级临时工作区所有权入口。 */
let sessionScratch: SessionScratchManager
/** Skill 解析缓存跨会话复用；每个根任务仍重新枚举并取得不可变快照。 */
let skills: SkillCatalogService
/** 删除跨多个存储始终单飞；历史删除不占用当前会话的运行时。 */
const sessionDeletionLock = new SessionDeletionLock()
/** 恢复或 Fork 完整校验与候选运行时构造期间，只允许一个物化事务。 */
const sessionPreparationLock = new SessionPreparationLock()
const sessionNavigation = new SessionNavigation({
  find: (sessionId) => runtimeRegistry.findBySessionId(sessionId),
  prepare: async (sessionId) => {
    const release = sessionPreparationLock.acquire(sessionId)
    if (!release) throw new Error(sessionPreparationInProgressMessage('恢复会话'))
    try {
      const runtime = await prepareResumedRuntime(sessionId)
      runtimeRegistry.add(runtime)
      runtimeRegistry.runtimeBecameIdle(runtime)
    } finally {
      release()
      nudgeNotificationQueues()
    }
  },
  snapshot: (runtime, historyStart) => runtimeSnapshot(runtime, historyStart),
  commit: (runtime) => {
    const previous = runtimeRegistry.select(runtime)
    if (previous && previous !== runtime) {
      void runtimeRegistry.removeUnselectedDraft(previous)
        .catch((error) => console.error('旧草稿释放失败：', error))
    }
  },
  settled: (runtime) => {
    nudgeNotificationQueues()
    const target = runtime ?? runtimeRegistry.selected
    // 重载窗口可能没有原 IPC Promise；让它在事务完成后重新获取权威快照。
    setTimeout(() => {
      if (target && !target.isDisposed) {
        target.emit({ type: 'agent-status', status: target.status }, false)
      }
    }, 0)
  },
})
/** 连接设置写入期间阻止启动新 Agent 工作，避免配置在请求中途切换。 */
let settingsMutationInProgress = false
const pdfProcessor = new ElectronPdfProcessor()
const officeProcessor = new ElectronOfficeProcessor(pdfProcessor)
const officeArtifactRunner = new ElectronOfficeArtifactRunner()
const hostOperations = new HostOperationScheduler()
const captureSessionScreenshot: typeof captureDesktopScreenshot = (request, abortSignal) =>
  hostOperations.runScreenshot(abortSignal, () => captureDesktopScreenshot(request, abortSignal))
const terminals = new TerminalSessions()

/** 会话创建前用户已选的权限档位（创建时应用） */
let preferredModelId: string | null = null
let preferredPermissionMode: PermissionMode = 'default'
let preferredConsensusEnabled = false

function selectedRuntime(): DesktopSessionRuntime {
  const runtime = runtimeRegistry.selected
  if (!runtime) throw new Error('当前会话运行时尚未初始化')
  return runtime
}

function runtimeForId(runtimeId?: string): DesktopSessionRuntime {
  if (!runtimeId) return selectedRuntime()
  const runtime = runtimeRegistry.get(runtimeId)
  if (!runtime) throw new Error('目标会话运行时已卸载，请从历史记录重新打开')
  return runtime
}

function worktreeBinding(
  workspace: RuntimeWorkspace | undefined,
): WorktreeWorkspaceBinding | null {
  return workspace?.mode === 'worktree' ? workspace : null
}

function sourceWorkspaceDirectory(workspace: RuntimeWorkspace): string {
  if (workspace.mode === 'pending-managed' || workspace.mode === 'ssh') return requireDefaultWorkspace()
  return workspaceProjectDirectory(workspace) ?? workspaceDisplayDirectory(workspace) ?? requireDefaultWorkspace()
}

function localWorkspaceDirectory(workspace: RuntimeWorkspace): string | null {
  return workspace.mode === 'ssh' ? null : workspaceDisplayDirectory(workspace)
}

async function currentWorktreeStatus(
  runtimeId: string,
): Promise<WorkspaceActionResult<WorktreeStatus>> {
  try {
    const binding = worktreeBinding(runtimeForId(runtimeId).workspace)
    if (!binding) throw new Error('当前会话使用本地工作区，没有受管 Worktree')
    return { ok: true, value: await worktrees.status(binding) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function createCurrentWorktreeBranch(
  runtimeId: string,
  branchName: string,
): Promise<WorkspaceActionResult> {
  let reservation: ReturnType<DesktopSessionRuntime['routingGate']['reserve']> | null = null
  try {
    const runtime = runtimeForId(runtimeId)
    const binding = worktreeBinding(runtime.workspace)
    if (!binding) throw new Error('当前会话使用本地工作区，没有受管 Worktree')
    if (
      runtime.sessionId
      && sessionDeletionLock.sessionId === runtime.sessionId
    ) {
      throw new Error('当前会话删除中，请等待完成')
    }
    reservation = runtime.routingGate.reserve()
    await reservation.ready
    if (runtime.executionBusy) throw new Error('Agent 工作中，请等待任务结束后再创建分支')
    if (runtime.sessionId) {
      const backgroundRunning = (await commandSessions.list(runtime.sessionId))
        .some((task) => task.status === 'running')
      if (backgroundRunning) throw new Error('仍有后台命令运行，请先停止后再创建分支')
    }
    const signal = new AbortController().signal
    await hostOperations.runProjectWrite(
      requireRuntimeProjectDir(runtime),
      signal,
      () => worktrees.createBranch(binding, branchName),
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    reservation?.release()
  }
}

async function openCurrentWorkspaceFolder(
  runtimeId: string,
): Promise<WorkspaceActionResult> {
  try {
    const targetRuntime = runtimeForId(runtimeId)
    if (targetRuntime.workspace.mode === 'ssh') throw new Error('远端文件夹请在工作区面板中查看')
    const path = requireRuntimeProjectDir(targetRuntime)
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function discardCurrentWorktree(runtimeId: string): Promise<DeleteSessionResult> {
  let replacementRuntime: DesktopSessionRuntime | null = null
  let detachedCurrent = false
  try {
    const runtime = runtimeForId(runtimeId)
    const binding = worktreeBinding(runtime.workspace)
    if (!binding) throw new Error('当前会话使用本地工作区，没有可丢弃的受管 Worktree')
    if (runtime.sessionId) return deleteSession(runtime.sessionId, { deleteDirectory: true, remoteCleanup: 'required' })
    if (runtime.busy) throw new Error('Agent 工作中，请先停止再丢弃 Worktree')

    const wasSelected = runtimeRegistry.selected === runtime
    await newSessionState.consume(runtime.runtimeId)
    await runtimeRegistry.remove(runtime)
    detachedCurrent = wasSelected
    await worktrees.remove(binding, true)
    if (wasSelected) {
      replacementRuntime = await getNewSessionRuntime()
      runtimeRegistry.select(replacementRuntime)
    }
    return {
      ok: true,
      deletedCurrent: wasSelected,
      cleanupPending: false,
      ...(replacementRuntime
        ? { snapshot: await runtimeSnapshot(replacementRuntime) }
        : {}),
    }
  } catch (error) {
    if (detachedCurrent && !replacementRuntime) {
      replacementRuntime = await getNewSessionRuntime()
      runtimeRegistry.select(replacementRuntime)
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      deletedCurrent: detachedCurrent || undefined,
      ...(replacementRuntime
        ? { snapshot: await runtimeSnapshot(replacementRuntime) }
        : {}),
    }
  }
}

function createDraftRuntime(
  workspace: RuntimeWorkspace,
  runtimeId?: string,
): DesktopSessionRuntime {
  workspaceLifecycle?.assertAvailable(localWorkspaceDirectory(workspace))
  const runtime = new DesktopSessionRuntime({
    runtimeId,
    workspace,
    modelId: resolveDefaultModelId(loadDisplayConfig(), preferredModelId),
    permissionMode: preferredPermissionMode,
    emit: broadcastRuntimeEvent,
  })
  runtime.workspaceIO = sshWorkspaces.io(runtime.workspace)
  runtime.consensusEnabled = runtime.workspace.mode === 'ssh' ? false : preferredConsensusEnabled
  runtimeRegistry.add(runtime)
  return runtime
}

async function getNewSessionRuntime(): Promise<DesktopSessionRuntime> {
  const saved = newSessionState.value
  const existing = saved ? runtimeRegistry.get(saved.runtimeId) : null
  if (existing && !existing.sessionId) return existing
  if (saved) return createDraftRuntime(saved.workspace, saved.runtimeId)
  const runtimeId = randomUUID()
  const workspace = prepareDefaultRuntimeWorkspace(runtimeId, managedWorkspaces)
  await newSessionState.set({ runtimeId, workspace })
  return createDraftRuntime(workspace, runtimeId)
}

/** Main 持有模型选择事实；首次读取时按配置初始化，之后保留用户的会话内选择。 */
function resolveCurrentModelId(runtime: DesktopSessionRuntime): string | null {
  runtime.modelId ??= resolveDefaultModelId(loadDisplayConfig(), preferredModelId)
  return runtime.modelId
}

async function materializeWorkspace(runtime: DesktopSessionRuntime): Promise<WorkspaceBinding> {
  const binding = await materializeRuntimeWorkspace(runtime, worktrees, managedWorkspaces)
  if (!runtime.journal) {
    if (runtime.sessionId) await sessions.preparations.updateWorkspace(runtime.sessionId, binding)
    else await newSessionState.updateWorkspace(runtime.runtimeId, binding)
  }
  return binding
}

async function ensureSession(runtime: DesktopSessionRuntime): Promise<string | null> {
  const config = loadAppConfig()
  const modelId = resolveCurrentModelId(runtime)
  if (!modelId) return '没有任何已配置 key 的模型可用'
  const resolved = resolveModelConnection(config, modelId)
  if (!resolved.ok) return resolved.error
  const { entry, providerConfig } = resolved.value
  runtime.reasoningEffort = normalizeReasoningEffortSelection(
    entry.capabilities,
    runtime.reasoningEffort,
  )
  if (runtime.session) {
    // 临时目录已随 AgentSession 初始化，后续输入只检查远端可用性。
    await sshWorkspaces.connect(runtime.workspace)
    await runtime.session.setModelSelection(entry, providerConfig, runtime.reasoningEffort)
  } else {
    if (!runtime.sessionInitialization) {
      let pending: Promise<string | null>
      pending = (async () => {
        const workspace = await materializeWorkspace(runtime)
        const recorder = runtime.journal ?? await createRuntimeJournal(
          workspace,
          modelId,
          runtime.reasoningEffort,
          runtime.sessionId ?? undefined,
        )
        runtime.journal = recorder
        await newSessionState.consume(runtime.runtimeId)
        await sessions.preparations.finish(recorder.sessionId)
        if (workspace.mode !== 'ssh') await sessionScratch.ensure(recorder.sessionId)
        if (workspace.mode === 'worktree') await worktrees.attachSession(workspace, recorder.sessionId)
        else if (workspace.mode === 'managed') await managedWorkspaces.attachSession(workspace, recorder.sessionId)
        terminals.bindSession(runtime.runtimeId, recorder.sessionId)
        await syncRetiredModelLabels()
        if (!runtime.session) {
          runtime.session = await createMainAgentSession(
            runtime,
            recorder,
            requireRuntimeProjectDir(runtime),
            entry,
            providerConfig,
            runtime.reasoningEffort,
          )
          runtime.coordinator = null
        }
        if (runtime.consensusEnabled && !runtime.coordinator) {
          return buildCoordinator(runtime)
        }
        return null
      })().finally(() => {
        if (runtime.sessionInitialization === pending) {
          runtime.sessionInitialization = null
          runtime.notifyStateChanged()
        }
      })
      runtime.sessionInitialization = pending
    }
    return runtime.sessionInitialization
  }
  if (runtime.consensusEnabled && !runtime.coordinator) {
    const err2 = buildCoordinator(runtime)
    if (err2) return err2
  }
  return null
}

async function createRuntimeJournal(
  workspace: WorkspaceBinding,
  modelId: string,
  reasoningEffort: ReasoningEffortSelection,
  sessionId?: string,
): Promise<SessionJournal> {
  const customSystemPrompt = await loadCustomSystemPromptSnapshot(
    customSystemPromptConfigPath,
  )
  return sessions.create(
    workspace,
    modelId,
    reasoningEffort,
    customSystemPrompt,
    sessionId,
  )
}

async function createMainAgentSession(
  runtime: DesktopSessionRuntime,
  recorder: SessionJournal,
  targetProjectDir: string,
  model: ModelEntry,
  providerConfig: ProviderConfig,
  reasoningEffort: ReasoningEffortSelection,
): Promise<AgentSession> {
  const remote = await sshWorkspaces.prepare(runtime)
  const scratch = remote?.scratch ?? sessionScratch.paths(recorder.sessionId)
  const forkSourceScratch = recorder.metadataSnapshot.forkOrigin
    ? remote ? sshScratchPaths(remote.home, recorder.metadataSnapshot.forkOrigin.sourceSessionId)
      : sessionScratch.paths(recorder.metadataSnapshot.forkOrigin.sourceSessionId)
    : null
  const mcpRuntime = new McpSessionRuntime({
    configuration: mcpOAuthController.runtimeConfiguration(
      await loadMcpConfiguration({
        globalConfigPath: mcpGlobalConfigPath,
        projectDir: remote ? undefined : targetProjectDir,
        globalSecretHeaders: loadAppConfig()?.mcpSecretHeaders,
      }),
    ),
    fetchImpl: (input, init) => net.fetch(
      input instanceof URL ? input.toString() : input,
      init,
    ),
    oauthTransportFactory: (config) => mcpOAuthController.runtimeTransport(config),
    attachments: {
      attachmentDirectory: recorder.attachmentDirectory,
      sessionId: recorder.sessionId,
    },
  })
  try {
    const commandTools = createCommandTools(commandSessions, recorder.sessionId)
    const baseTools = BUILTIN_TOOLS.map((tool) =>
      tool.name === RUN_COMMAND_TOOL_NAME ? commandTools.runCommand : tool,
    )
    const next = new AgentSession({
      model,
      providerConfig,
      reasoningEffort,
      workspaceIO: runtime.workspaceIO,
      promptContext: {
        projectDir: targetProjectDir,
        osPlatform: remote ? 'linux' : process.platform,
        homeDir: remote?.home ?? app.getPath('home'),
        scratch: {
          rootDir: scratch.rootDirectory,
          workingDir: scratch.mainDirectory,
          ...(forkSourceScratch
            ? { forkSourceRootDir: forkSourceScratch.rootDirectory }
            : {}),
        },
      },
      customSystemPrompt: recorder.customSystemPrompt,
      baseTools,
      sessionRecorder: recorder,
      mcpRuntime,
      skillCatalog: await skillCatalogFor(runtime),
      subagentCatalog: subagentDefinitions,
      mainTools: [
        ...(!remote ? [createBuildOfficeArtifactTool(officeArtifactRunner), createInspectOfficeTool(officeProcessor)] : []),
        ...commandTools.taskTools,
        ...subagents.createTools(runtime, recorder, targetProjectDir),
        webSearchTool,
        ...createSessionWebPageTools(recorder),
      ],
      captureScreenshot: remote ? undefined : captureSessionScreenshot,
      pdfProcessor,
      officeProcessor: remote ? undefined : officeProcessor,
      auxiliaryImageAnalyzer: configuredAuxiliaryImageAnalyzer(),
      hasPendingTaskPlanContinuation: (planId) =>
        commandSessions.hasPendingPlanContinuation(recorder.sessionId, planId)
        || subagents.hasPendingPlanContinuation(recorder.sessionId, planId),
      getSubagentTurnState: (turnId) => subagents.turnState(recorder.sessionId, turnId),
      scheduleProjectMutation: (_mutation, abortSignal, operation) =>
        hostOperations.runProjectWrite(requireRuntimeProjectDir(runtime), abortSignal, operation, runtime.workspaceIO?.identity),
      emit: (event) => runtime.emit(event),
      requestApproval: (request, signal) => runtime.requestApproval(request, signal),
    })
    next.setPermissionMode(runtime.permissionMode)
    await next.initializeContextUsage()
    return next
  } catch (error) {
    await mcpRuntime.close().catch(() => {})
    throw error
  }
}

async function skillCatalogFor(runtime: DesktopSessionRuntime): Promise<SkillCatalogService> {
  if (runtime.workspace.mode !== 'ssh') return skills
  const host = await sshWorkspaces.connect(runtime.workspace)
  runtime.skillCatalog ??= new SkillCatalogService({ homeDir: host!.home, workspaceIO: sshWorkspaces.io(runtime.workspace) })
  return runtime.skillCatalog
}

function configuredAuxiliaryImageAnalyzer(config: WhycodeConfig | null = loadAppConfig()) {
  const resolved = resolveAuxiliaryVisionModel(config)
  return resolved
    ? createAuxiliaryImageAnalyzer({
        model: resolved.entry,
        providerConfig: resolved.providerConfig,
      })
    : undefined
}

/** 根输入开始前按当前全局配置刷新；运行中的 turn 保持其已开始的模型边界。 */
function synchronizeRuntimeAuxiliaryImageAnalyzer(
  runtime: DesktopSessionRuntime,
  config: WhycodeConfig | null,
): void {
  if (!runtime.session || runtime.session.isBusy) return
  runtime.session.setAuxiliaryImageAnalyzer(configuredAuxiliaryImageAnalyzer(config))
}

/** 协商可用性检查：B/C 评审员只引用统一模型连接，不持有独立凭据。 */
function checkConsensusReady(): string | null {
  try {
    const resolved = resolveConsensusAgentSetups(loadAppConfig())
    return resolved.ok ? null : resolved.error
  } catch (error) {
    if (!(error instanceof ConfigReadError)) throw error
    return error.message
  }
}

function buildCoordinator(runtime: DesktopSessionRuntime): string | null {
  if (runtime.workspace.mode === 'ssh') return 'SSH 工作区暂不支持协商模式'
  const journal = runtime.journal
  if (!journal) return '会话记录尚未初始化，无法启动协商'
  const result = createCoordinator(
    runtime,
    runtime.session!,
    journal,
    requireRuntimeProjectDir(runtime),
    sessionScratch.paths(journal.sessionId).rootDirectory,
  )
  if (!result.ok) return result.error
  runtime.coordinator = result.value
  return null
}

function createCoordinator(
  runtime: DesktopSessionRuntime,
  mainSession: AgentSession,
  journal: SessionJournal,
  targetProjectDir: string,
  targetSessionScratchDir: string,
): { ok: true; value: ConsensusCoordinator } | { ok: false; error: string } {
  const agents = resolveConsensusAgentSetups(loadAppConfig())
  if (!agents.ok) return agents
  const value = new ConsensusCoordinator({
    mainSession,
    projectDir: targetProjectDir,
    sessionScratchDir: targetSessionScratchDir,
    agents: agents.value,
    osPlatform: process.platform,
    homeDir: app.getPath('home'),
    emit: (event) => runtime.emit(event),
    requestApproval: (request, signal) => runtime.requestApproval(request, signal),
    initialState: journal.initialConsensusState,
    onTaskStart: (taskId, state, userText, deliveredInputIds, skills) =>
      journal.recordConsensusTaskStart(taskId, state, userText, deliveredInputIds, skills),
    onTaskEnd: (taskId, outcome, state) =>
      journal.recordConsensusTaskEnd(taskId, outcome, state),
    onInputsRestored: (inputIds) => journal.markUserInputsRestored(inputIds),
    onInputsDiscarded: (inputIds) => journal.markUserInputsDiscarded(inputIds),
    onDeferredTaskStart: () => runtime.beginWork(),
  })
  return { ok: true, value }
}

async function handleCommand(
  runtime: DesktopSessionRuntime,
  command: CoreCommand,
): Promise<RuntimeCommandResult | void> {
  if (
    runtime.sessionId
    && sessionDeletionLock.blocksSession(runtime.sessionId)
  ) {
    runtime.emit({
      type: 'error',
      message: '会话数据删除中，请等待完成后再操作',
      recoverable: true,
    })
    return { ok: false }
  }
  switch (command.type) {
    case 'user-message':
      return handleUserMessageCommand(runtime, command)
    case 'queued-message-action':
      return handleQueuedMessageAction(runtime, command)
    case 'btw-message':
      return handleBtwMessageCommand(runtime, command)
    case 'inspect-user-message-edit': {
      try {
        if (runtimeBusy(runtime) || !runtime.journal) {
          return { ok: false, error: 'Agent 尚未空闲，不能编辑最新消息' }
        }
        await runtime.timeline.flush()
        const editEffects = runtime.session
          ? await runtime.session.inspectLatestTurnEdit(command.turnId)
          : await inspectLatestTurnEdit(runtime.journal, command.turnId)
        return { ok: true, editEffects }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
    case 'edit-user-message':
      return handleEditUserMessageCommand(runtime, command)
    case 'abort': {
      // 中断时把所有挂起的审批一并拒绝，避免 run 永久卡在 await 上
      const subagentAbort = runtime.sessionId
        ? subagents.beginParentAbort(runtime.sessionId)
        : null
      await Promise.all([
        runtime.abort(
          'user',
          subagentAbort?.interruptedSubagents.length
            ? { interruptedSubagents: subagentAbort.interruptedSubagents }
            : undefined,
        ),
        subagentAbort?.done ?? Promise.resolve(),
      ])
      break
    }
    case 'set-consensus': {
      if (!command.enabled) {
        if (runtime.coordinator?.busy) {
          runtime.emit({ type: 'error', message: '协商进行中，请先停止再关闭', recoverable: true })
          return { ok: false }
        }
        runtime.consensusEnabled = false
        preferredConsensusEnabled = false
        return { ok: true }
      }
      const notReady = runtime.workspace.mode === 'ssh' ? 'SSH 工作区暂不支持协商模式' : checkConsensusReady()
      if (notReady) {
        runtime.emit({ type: 'error', message: notReady, recoverable: true })
        return { ok: false }
      }
      runtime.consensusEnabled = true
      preferredConsensusEnabled = true
      return { ok: true }
    }
    case 'set-permission-mode': {
      // 权限是应用级执行边界，必须在任何磁盘等待之前同步到全部已加载会话；否则界面
      // 已显示新档位时，后台会话仍可能按旧档位执行。持久化只负责重启后的偏好。
      preferredPermissionMode = command.mode
      runtimeRegistry.setPermissionModeForAll(command.mode)
      subagents.setPermissionModeForAll(command.mode)
      try {
        await persistPermissionMode(command.mode)
      } catch (error) {
        runtime.emit({
          type: 'error',
          message: `权限档位已在全部会话生效，但偏好保存失败；重启后可能恢复旧档位：${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        })
      }
      return { ok: true }
    }
    case 'check-checkpoint-restore': {
      if (runtimeBusy(runtime)) {
        return { ok: false, error: 'Agent 工作中，请等待当前任务结束后再回滚' }
      }
      if (runtime.journal) {
        const error = await ensureSession(runtime)
        if (error) return { ok: false, error }
      }
      if (!runtime.session) return { ok: false, error: '该操作没有可用快照' }
      const result = await runtime.session.checkCheckpointRestore(
        command.toolUseId,
        command.scope,
      )
      return { ok: result.ok, error: result.error }
    }
    case 'restore-checkpoint': {
      if (runtimeBusy(runtime)) {
        runtime.emit({
          type: 'checkpoint-restored',
          toolUseId: command.toolUseId,
          turnId: '',
          scope: command.scope,
          ok: false,
          error: 'Agent 工作中，请等待当前任务结束后再回滚',
        }, false)
        break
      }
      try {
        const error = await ensureSession(runtime)
        if (error) throw new Error(error)
        await runtime.session?.restoreCheckpoint(command.toolUseId, command.scope)
      } catch (error) {
        runtime.emit({ type: 'checkpoint-restored', toolUseId: command.toolUseId, turnId: '',
          scope: command.scope, ok: false, error: error instanceof Error ? error.message : String(error) }, false)
      }
      break
    }
    case 'compact': {
      if (runtime.attachmentPreparationInProgress) {
        runtime.emit({
          type: 'error',
          message: '附件消息准备中，请等待提交完成后再压缩',
          recoverable: true,
        })
        return { ok: false }
      }
      if (!runtime.session && !runtime.journal) {
        runtime.emit({ type: 'error', message: '还没有对话，无需压缩', recoverable: true })
        break
      }
      const error = await ensureSession(runtime)
      if (error) {
        runtime.emit({ type: 'error', message: error, recoverable: true })
        return { ok: false }
      }
      await runtime.session!.compactNow()
      break
    }
    case 'set-model': {
      if (settingsMutationInProgress) {
        runtime.emit({ type: 'error', message: '连接设置处理中，请稍后再切换模型', recoverable: true })
        return { ok: false }
      }
      if (runtime.attachmentPreparationInProgress) {
        runtime.emit({
          type: 'error',
          message: '附件消息准备中，请等待提交完成后再切换模型',
          recoverable: true,
        })
        return { ok: false }
      }
      const resolved = resolveModelConnection(loadAppConfig(), command.modelId)
      if (!resolved.ok) {
        runtime.emit({ type: 'error', message: resolved.error, recoverable: true })
        return { ok: false }
      }
      const targetReasoningEffort = 'default'
      if (runtime.session) {
        await runtime.session.setModelSelection(
          resolved.value.entry,
          resolved.value.providerConfig,
          targetReasoningEffort,
        )
      } else if (runtime.journal) {
        await runtime.journal.updateModelSelection(command.modelId, targetReasoningEffort)
      }
      runtime.modelId = command.modelId
      runtime.reasoningEffort = targetReasoningEffort
      preferredModelId = command.modelId
      if (!runtime.session && runtime.journal) {
        const initializationError = await ensureSession(runtime)
        if (initializationError) {
          runtime.emit({ type: 'error', message: initializationError, recoverable: true })
          return { ok: false }
        }
      }
      try {
        await persistPreferredModel(command.modelId)
      } catch (error) {
        runtime.emit({
          type: 'error',
          message: `模型已在当前会话生效，但偏好或历史显示名保存失败；重启后请核对模型选择：${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        })
      }
      return { ok: true }
    }
    case 'set-reasoning-effort': {
      if (settingsMutationInProgress || runtime.attachmentPreparationInProgress) {
        runtime.emit({
          type: 'error',
          message: settingsMutationInProgress
            ? '连接设置处理中，请稍后再调整推理强度'
            : '附件消息准备中，请等待提交完成后再调整推理强度',
          recoverable: true,
        })
        return { ok: false }
      }
      const modelId = resolveCurrentModelId(runtime)
      if (!modelId) {
        runtime.emit({ type: 'error', message: '当前没有可用模型', recoverable: true })
        return { ok: false }
      }
      const resolved = resolveModelConnection(loadAppConfig(), modelId)
      if (!resolved.ok) {
        runtime.emit({ type: 'error', message: resolved.error, recoverable: true })
        return { ok: false }
      }
      const normalized = normalizeReasoningEffortSelection(
        resolved.value.entry.capabilities,
        command.reasoningEffort,
      )
      if (normalized !== command.reasoningEffort) {
        runtime.emit({
          type: 'error',
          message: `${resolved.value.entry.displayName} 不支持推理强度 ${command.reasoningEffort}`,
          recoverable: true,
        })
        return { ok: false }
      }
      if (runtime.session) {
        await runtime.session.setModelSelection(
          resolved.value.entry,
          resolved.value.providerConfig,
          normalized,
        )
      }
      runtime.reasoningEffort = normalized
      return { ok: true }
    }
    case 'approval-response': {
      runtime.respondApproval(command.requestId, {
        approved: command.approved,
        remember: command.remember,
      })
      break
    }
  }
}

type UserMessageCommand = Extract<CoreCommand, { type: 'user-message' }>
type BtwMessageCommand = Extract<CoreCommand, { type: 'btw-message' }>
type EditUserMessageCommand = Extract<CoreCommand, { type: 'edit-user-message' }>
type PreparedUserMessage = PreparedUserMessageAttachments & { skills: ActivatedSkill[] }

async function handleEditUserMessageCommand(
  runtime: DesktopSessionRuntime,
  command: EditUserMessageCommand,
): Promise<RuntimeCommandResult> {
  if (command.target.kind === 'btw') {
    return handleEditBtwMessageCommand(runtime, command.target.inputId, command.text)
  }
  if (settingsMutationInProgress) {
    return { ok: false }
  }
  const reservation = runtimeRegistry.reserveWorkStart(runtime)
  if (!reservation) {
    return { ok: false }
  }
  return startEditedUserMessage(runtime, reservation, {
    turnId: command.target.turnId,
    text: command.text,
    restoreFiles: command.target.restoreFiles === true,
    prepareSession: async () => {
      const error = await ensureSession(runtime)
      if (error) throw new Error(error)
      synchronizeRuntimeAuxiliaryImageAnalyzer(runtime, loadAppConfig())
    },
    deliver: (prepared) => deliverEditedUserMessage(runtime, prepared),
    onDeliveryError: (error) => reportUserMessageDeliveryError(runtime, error),
  })
}

async function prepareUserMessage(
  runtime: DesktopSessionRuntime,
  command: UserMessageCommand,
): Promise<PreparedUserMessage> {
  const config = loadAppConfig()
  if (!userMessageNeedsAttachmentPreparation(command)) {
    const skillsBeforeSession = runtime.projectDir === null
      ? await prepareUserMessageSkills(runtime, command)
      : null
    const error = await ensureSession(runtime)
    if (error) throw new Error(error)
    synchronizeRuntimeAuxiliaryImageAnalyzer(runtime, config)
    return {
      attachments: [],
      pdfAttachments: [],
      restoredInputIds: [],
      importedFiles: false,
      skills: skillsBeforeSession ?? await prepareUserMessageSkills(runtime, command),
    }
  }

  const modelId = resolveCurrentModelId(runtime)
  if (!modelId) throw new Error('没有任何已配置 key 的模型可用')
  const resolved = resolveModelConnection(config, modelId)
  if (!resolved.ok) throw new Error(resolved.error)
  const model = resolved.value.entry
  const skillsBeforeSession = runtime.projectDir === null
    ? await prepareUserMessageSkills(runtime, command)
    : null
  const attachmentAbortSignal = runtime.beginAttachmentPreparation()
  try {
    const error = await ensureSession(runtime)
    if (error) throw new Error(error)
    synchronizeRuntimeAuxiliaryImageAnalyzer(runtime, config)
    const preparedSkills = skillsBeforeSession ?? await prepareUserMessageSkills(runtime, command)
    const journal = runtime.journal
    if (!journal) throw new Error('会话记录尚未初始化，无法保存附件')
    const prepared = await prepareAttachments({
      command,
      journal,
      pdfProcessor,
      imageInputMode: imageInputModeForModel(config, model),
      modelDisplayName: model.displayName,
      abortSignal: attachmentAbortSignal,
    })
    return {
      ...prepared,
      skills: preparedSkills,
    }
  } catch (error) {
    throw new Error(`消息准备失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    runtime.endAttachmentPreparation()
  }
}

async function prepareUserMessageSkills(
  runtime: DesktopSessionRuntime,
  command: UserMessageCommand,
): Promise<ActivatedSkill[]> {
  if (command.skills === undefined) return []
  const modelId = resolveCurrentModelId(runtime)
  if (!modelId) throw new Error('没有任何已配置 key 的模型可用')
  const resolved = resolveModelConnection(loadAppConfig(), modelId)
  if (!resolved.ok) throw new Error(resolved.error)
  return prepareMessageSkills({
    catalog: await skillCatalogFor(runtime),
    locators: command.skills,
    projectDir: runtime.projectDir,
    contextWindow: resolved.value.entry.capabilities.contextWindow,
    restoredInputIds: command.restoredInputIds,
    pendingInputs: runtime.journal?.pendingUserInputs,
  })
}

async function handleUserMessageCommand(
  runtime: DesktopSessionRuntime,
  command: UserMessageCommand,
): Promise<RuntimeCommandResult> {
  if (settingsMutationInProgress) {
    return rejectUserMessage(runtime, '连接设置处理中，请等待完成后再发送消息')
  }
  if (runtime.attachmentPreparationInProgress) {
    return rejectUserMessage(runtime, '上一条附件消息仍在准备，请稍后重试')
  }
  const workStart = runtimeRegistry.reserveWorkStart(runtime)
  if (!workStart) {
    return rejectUserMessage(
      runtime,
      `同时运行的对话已达到上限（${MAX_CONCURRENT_AGENT_RUNS} 个），请等待其中一个结束`,
    )
  }
  try {
    let prepared: PreparedUserMessage
    try {
      await workStart.ready
      if (!runtime.sessionId) {
        const modelId = resolveCurrentModelId(runtime)
        if (!modelId) throw new Error('没有任何已配置 key 的模型可用')
        await sessions.preparations.register({
          sessionId: runtime.runtimeId,
          workspace: runtime.workspace,
          modelId,
          reasoningEffort: runtime.reasoningEffort,
          lastUserText: command.text.trim().slice(0, 200),
        })
        await projects.attachSession(runtime.runtimeId, runtime.workspace)
        runtime.registerSession()
        await newSessionState.consume(runtime.runtimeId)
        terminals.bindSession(runtime.runtimeId, runtime.runtimeId)
      }
      if (!runtime.journal) runtime.beginWork()
      prepared = await prepareUserMessage(runtime, command)
    } catch (error) {
      if (!runtime.session) runtime.finishWork()
      return rejectUserMessage(runtime, error instanceof Error ? error.message : String(error))
    }

    const userText = command.text.trim()
      || attachmentFallbackText(
        prepared.attachments.length,
        prepared.pdfAttachments.length,
      )
    if (!userText && prepared.attachments.length === 0) {
      return rejectUserMessage(runtime, '消息不能为空')
    }
    try {
      await routeUserMessage(userText, command.urgent ?? false, {
        isBusy: () => runtimeExecutionBusy(runtime),
        reserve: () => runtime.routingGate.reserve(),
        record: (inputId, text, startsTurn) => recordUserInput(
          runtime,
          inputId,
          text,
          startsTurn,
          prepared.attachments,
          prepared.imageDelivery,
          prepared.restoredInputIds,
          prepared.pdfAttachments,
          prepared.skills,
        ),
        acceptRoot: (inputId, text) => {
          runtime.beginWork()
          runtime.emit({
            type: 'user-message-accepted',
            inputId,
            text,
            startsTurn: true,
            ...(prepared.attachments.length ? { attachments: prepared.attachments } : {}),
            ...(prepared.pdfAttachments.length ? { pdfAttachments: prepared.pdfAttachments } : {}),
            ...(prepared.skills.length ? { skills: prepared.skills.map(skillSummary) } : {}),
          }, false)
        },
        deliver: (inputId, text, urgent, startsTurn) => deliverUserMessage(
          runtime,
          inputId,
          text,
          urgent,
          startsTurn,
          prepared.attachments,
          prepared.imageDelivery,
          prepared.pdfAttachments,
          prepared.skills,
        ),
        onDeliveryError: (error) => reportUserMessageDeliveryError(runtime, error),
      }, workStart)
    } catch (error) {
      const journal = runtime.journal
      if (prepared.importedFiles && journal) {
        await cleanupUnreferencedAttachments(journal.attachmentDirectory, {
          imageAttachments: journal.initialImageAttachments,
          pdfAttachments: journal.initialPdfAttachments,
        }).catch(() => {})
      }
      return rejectUserMessage(
        runtime,
        `用户消息未能安全交付：${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return { ok: true, workspace: runtime.workspace }
  } finally {
    // routeUserMessage 正常路径已释放；准备阶段失败时由这里释放。release 幂等。
    workStart.release()
    if (!runtime.busy) runtime.emit({ type: 'agent-status', status: 'idle' }, false)
    // 若后台终态正因 AskUserQuestion 等待真实回答，此时用户输入已优先完成路由，
    // 可在下一稳定步骤边界把通知交给同一 Agent，而不占用第二套轮询或计时器。
    nudgeNotificationQueues()
  }
}

async function handleQueuedMessageAction(
  runtime: DesktopSessionRuntime,
  command: Extract<CoreCommand, { type: 'queued-message-action' }>,
): Promise<RuntimeCommandResult> {
  const reservation = runtime.routingGate.reserve()
  try {
    await reservation.ready
    const target = runtime.coordinator ?? runtime.session
    if (!target) {
      runtime.emit({ type: 'error', message: '当前会话尚未就绪，无法操作排队消息', recoverable: true })
      return { ok: false, workspace: runtime.workspace }
    }
    const handled = command.action === 'edit'
      ? await target.restoreQueuedMessage(command.id)
      : command.action === 'discard'
        ? await target.discardQueuedMessage(command.id)
        : target.sendQueuedMessageNow(command.id)
    if (handled) return { ok: true, workspace: runtime.workspace }

    // 消息可能恰好在点击时完成注入；事实源已不再排队就视为幂等成功。
    const stillQueued = runtime.journal?.pendingUserInputs.some(
      (input) => input.id === command.id && input.state === 'queued',
    ) ?? false
    if (!stillQueued) return { ok: true, workspace: runtime.workspace }
    runtime.emit({ type: 'error', message: '排队消息状态已经变化，请重试', recoverable: true })
    return { ok: false, workspace: runtime.workspace }
  } catch (error) {
    runtime.emit({
      type: 'error',
      message: `排队消息操作失败：${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
    })
    return { ok: false, workspace: runtime.workspace }
  } finally {
    reservation.release()
  }
}

async function handleBtwMessageCommand(
  runtime: DesktopSessionRuntime,
  command: BtwMessageCommand,
): Promise<RuntimeCommandResult> {
  if (settingsMutationInProgress) {
    return rejectUserMessage(runtime, '连接设置处理中，请等待完成后再发送 BTW')
  }
  if (runtimeBusy(runtime) || runtime.attachmentPreparationInProgress) {
    return rejectUserMessage(runtime, '当前对话仍在工作，结束后才能发送 BTW')
  }
  const reservation = runtimeRegistry.reserveWorkStart(runtime)
  if (!reservation) {
    return rejectUserMessage(
      runtime,
      `同时运行的对话已达到上限（${MAX_CONCURRENT_AGENT_RUNS} 个），请稍后重试`,
    )
  }
  let imageImport: Awaited<ReturnType<typeof prepareImageAttachmentImport>> | null = null
  let persistedContext: BtwTurnContext | null = null
  let btwWorkStarted = false
  try {
    await reservation.ready
    // 与普通消息共用 FIFO：斜杠菜单状态只是提示，最终仍以排到队首时的真实状态为准。
    if (runtimeExecutionBusy(runtime)) {
      return rejectUserMessage(runtime, '当前对话仍在工作，结束后才能发送 BTW')
    }
    const initializationError = await ensureSession(runtime)
    if (initializationError) return rejectUserMessage(runtime, initializationError)
    const journal = runtime.journal
    const session = runtime.session
    if (!journal || !session) {
      return rejectUserMessage(runtime, '会话尚未准备完成，不能发送 BTW')
    }
    await runtime.timeline.flush()
    const hasCompletedMainResponse = journal.initialViewEvents.some((event) =>
      event.type === 'core-event'
      && event.event.type === 'work-finished'
      && event.event.outcome === 'completed'
      && event.event.forkTurnId !== null)
    if (!hasCompletedMainResponse) {
      return rejectUserMessage(runtime, '先完成一次正常对话，才能使用 BTW')
    }
    const modelId = resolveCurrentModelId(runtime)
    const resolved = modelId ? resolveModelConnection(loadAppConfig(), modelId) : null
    if (!resolved?.ok) {
      return rejectUserMessage(runtime, resolved?.error ?? '当前没有可用模型')
    }
    const imageInputs = command.attachments ?? []
    if (imageInputs.some((input) => input.kind === 'stored')) {
      return rejectUserMessage(runtime, 'BTW 不接受恢复队列中的旧附件')
    }
    if (imageInputs.length > 0 && !resolved.value.entry.capabilities.supportsImageInput) {
      return rejectUserMessage(runtime, 'BTW 只允许当前模型原生读取图片')
    }
    const signal = runtime.beginAttachmentPreparation()
    try {
      imageImport = await prepareImageAttachmentImport(
        imageInputs as ImageAttachmentInput[],
        journal.attachmentDirectory,
        journal.sessionId,
        { abortSignal: signal, maxCount: USER_IMAGE_ATTACHMENT_MAX_COUNT },
      )
      await imageImport.commit()
    } finally {
      runtime.endAttachmentPreparation()
    }
    const attachments = [...imageImport.attachments]
    const text = command.text.trim() || attachmentFallbackText(attachments.length, 0)
    if (!text && attachments.length === 0) {
      await imageImport.rollback()
      return rejectUserMessage(runtime, 'BTW 消息不能为空')
    }
    let context
    try {
      context = await journal.recordBtwInput(command.mode, text, attachments)
    } catch (error) {
      await imageImport.rollback().catch(() => {})
      return rejectUserMessage(runtime, error instanceof Error ? error.message : String(error))
    }
    persistedContext = context
    runtime.beginBtwWork()
    btwWorkStarted = true
    startPersistedBtw(runtime, journal, session, context, {
      type: 'btw-message-accepted',
      inputId: context.inputId,
      text,
      ...(attachments.length ? { attachments } : {}),
      btw: {
        conversationId: context.conversationId,
        turnIndex: context.turnIndex,
        mode: context.mode,
      },
    })
    return { ok: true, workspace: runtime.workspace }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (persistedContext) {
      // 输入一旦成为 JSONL 事实就不能再回滚其附件；启动失败也必须补齐独立终态。
      await finishFailedPersistedBtw(runtime, persistedContext, message, btwWorkStarted)
      return { ok: true, workspace: runtime.workspace }
    }
    await imageImport?.rollback().catch(() => {})
    return rejectUserMessage(runtime, message)
  } finally {
    reservation.release()
  }
}

async function handleEditBtwMessageCommand(
  runtime: DesktopSessionRuntime,
  inputId: string,
  text: string,
): Promise<{ ok: boolean }> {
  if (settingsMutationInProgress) return { ok: false }
  const reservation = runtimeRegistry.reserveWorkStart(runtime)
  if (!reservation) return { ok: false }
  let context: BtwTurnContext | null = null
  let workStarted = false
  try {
    await reservation.ready
    if (runtimeExecutionBusy(runtime)) return { ok: false }
    const initializationError = await ensureSession(runtime)
    if (initializationError) return { ok: false }
    const journal = runtime.journal
    const session = runtime.session
    if (!journal || !session) return { ok: false }
    await runtime.timeline.flush()
    const latest = journal.latestBtwTurn
    if (!latest || latest.inputId !== inputId) return { ok: false }
    const modelId = resolveCurrentModelId(runtime)
    const resolved = modelId ? resolveModelConnection(loadAppConfig(), modelId) : null
    if (!resolved?.ok) return { ok: false }
    if (latest.attachments.length > 0 && !resolved.value.entry.capabilities.supportsImageInput) {
      return { ok: false }
    }
    context = await journal.recordBtwEditInput(inputId, text.trim())
    runtime.beginBtwWork()
    workStarted = true
    startPersistedBtw(runtime, journal, session, context, {
      type: 'btw-message-edited',
      previousInputId: inputId,
      inputId: context.inputId,
      text: context.text,
      btw: {
        conversationId: context.conversationId,
        turnIndex: context.turnIndex,
        mode: context.mode,
      },
    })
    return { ok: true }
  } catch (error) {
    if (!context) return { ok: false }
    await finishFailedPersistedBtw(
      runtime,
      context,
      error instanceof Error ? error.message : String(error),
      workStarted,
    )
    return { ok: true }
  } finally {
    reservation.release()
  }
}

function startPersistedBtw(
  runtime: DesktopSessionRuntime,
  journal: SessionJournal,
  session: AgentSession,
  context: BtwTurnContext,
  inputEvent: Extract<CoreEvent, { type: 'btw-message-accepted' | 'btw-message-edited' }>,
): void {
  runtime.emit(inputEvent, false)
  void session.handleBtwMessage(context, {
    emit: (event) => runtime.emitBtw(event),
    onSettled: async (result, continuesWithMainWork) => {
      const settlement = await journal.recordBtwResponse(context, result)
      runtime.timeline.discardAll()
      if (result.outcome === 'completed') runtime.emit({ type: 'step-committed' }, false)
      runtime.finishBtwWork(
        result.durationMs,
        result.outcome,
        continuesWithMainWork,
        btwWorkProjection(context, settlement.continuationAvailable),
      )
    },
  }).catch((error) => {
    runtime.timeline.discardAll()
    runtime.emit({
      type: 'error',
      message: `BTW 异常退出：${error instanceof Error ? error.message : String(error)}`,
      recoverable: true,
    }, false)
    runtime.finishBtwWork(0, 'error', false, btwWorkProjection(context, false))
    runtime.emit({ type: 'agent-status', status: 'error' }, false)
  })
}

async function finishFailedPersistedBtw(
  runtime: DesktopSessionRuntime,
  context: BtwTurnContext,
  message: string,
  workStarted: boolean,
): Promise<void> {
  const settlement = await runtime.journal?.recordBtwResponse(context, {
    outcome: 'error',
    assistantText: '',
    reasoningText: '',
    reasoningDurationMs: 0,
    durationMs: 0,
    error: message,
  }).catch((persistenceError) => {
    runtime.emit({
      type: 'error',
      message: `BTW 失败终态未能写入：${
        persistenceError instanceof Error ? persistenceError.message : String(persistenceError)
      }`,
      recoverable: true,
    }, false)
    return null
  })
  runtime.timeline.discardAll()
  runtime.emit({ type: 'error', message: `BTW 启动失败：${message}`, recoverable: true }, false)
  if (workStarted) {
    runtime.finishBtwWork(
      0,
      'error',
      false,
      btwWorkProjection(context, settlement?.continuationAvailable ?? false),
    )
  }
  runtime.emit({ type: 'agent-status', status: 'error' }, false)
}

function btwWorkProjection(
  context: BtwTurnContext,
  continuationAvailable: boolean,
) {
  return {
    conversationId: context.conversationId,
    turnIndex: context.turnIndex,
    continuationAvailable,
  }
}

function deliverUserMessage(
  runtime: DesktopSessionRuntime,
  inputId: string,
  text: string,
  urgent: boolean,
  startsTurn: boolean,
  attachments: readonly ImageAttachment[],
  imageDelivery: ImageDeliveryMode | undefined,
  pdfAttachments: readonly PdfAttachment[],
  skills: readonly ActivatedSkill[],
): Promise<unknown> | void {
  const persistedInputId = startsTurn ? undefined : inputId
  if (runtime.consensusEnabled && runtime.coordinator) {
    return runtime.coordinator.handleUserMessage(
      text, urgent, attachments, persistedInputId, pdfAttachments, skills,
      imageDelivery,
    )
  }
  return runtime.session!.handleUserMessage(
    text, urgent, attachments, inputId, pdfAttachments, skills, imageDelivery,
  )
}

function reportUserMessageDeliveryError(
  runtime: DesktopSessionRuntime,
  error: unknown,
): void {
  runtime.emit({
    type: 'error',
    message: `Agent 接收消息后异常退出：${error instanceof Error ? error.message : String(error)}`,
    recoverable: true,
  })
  runtime.emit({ type: 'agent-status', status: 'error' }, false)
}

function runtimeBusy(runtime: DesktopSessionRuntime): boolean {
  return Boolean(
    sessionDeletionLock.blocksSession(runtime.sessionId ?? undefined)
    || runtime.busy,
  )
}

function runtimeExecutionBusy(runtime: DesktopSessionRuntime): boolean {
  return Boolean(
    sessionDeletionLock.blocksSession(runtime.sessionId ?? undefined)
    || runtime.executionBusy,
  )
}

function anyRuntimeBusy(): boolean {
  return settingsMutationInProgress || runtimeRegistry.anyBusy()
}

function sessionPreparationInProgressMessage(action: string): string {
  const operation = sessionPreparationLock.kind === 'fork'
    ? '正在创建会话分支'
    : '正在验证附件并恢复会话'
  return `${operation}，请等待完成后再${action}`
}

function mcpOAuthInProgressMessage(action: string): string {
  return `MCP OAuth 登录进行中，请完成后再${action}`
}

async function persistConnectionConfig(
  config: NonNullable<ReturnType<typeof loadAppConfig>>,
  invalidateConsensus = false,
): Promise<void> {
  config = pruneInvalidConsensusAgents(pruneInvalidAuxiliaryModels(config))
  await saveConfig(config, configSecretCodec, getConfigPath())
  if (invalidateConsensus) {
    const consensusReady = resolveConsensusAgentSetups(config).ok
    if (!consensusReady) preferredConsensusEnabled = false
    for (const runtime of runtimeRegistry.all()) {
      runtime.coordinator = null
      if (!consensusReady) runtime.consensusEnabled = false
    }
  }
  preferredModelId = resolveDefaultModelId(config, preferredModelId)
  for (const runtime of runtimeRegistry.all()) {
    await synchronizeRuntimeModelSelection(runtime, config, preferredModelId)
    synchronizeRuntimeAuxiliaryImageAnalyzer(runtime, config)
  }
}

const synchronizeConfiguredCliProxyRoutes = createCliProxyRouteSynchronizer(
  loadAppConfig,
  (config) => saveConfig(config, configSecretCodec, getConfigPath()),
  (input, init) => net.fetch(input, init),
)

function syncRetiredModelLabels(excludedSessionId?: string): Promise<void> {
  return persistRuntimePreferences({}, excludedSessionId)
}

async function saveProviderModelSettings(
  request: SaveProviderSettingsRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    const next = updateProviderSettings(loadAppConfig(), request)
    await persistConnectionConfig(next, true)
  })
}

async function saveCliProxyApiConnectionSettings(
  request: SaveCliProxyApiSettingsRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    const next = updateCliProxyApiSettings(loadAppConfig(), request)
    if (next.cliProxyApi?.apiKey) {
      const modelRoutes = await discoverCliProxyRoutes(
        next.cliProxyApi,
        (input, init) => net.fetch(input, init),
      )
      next.cliProxyApi.modelRoutes = modelRoutes
    }
    await persistConnectionConfig(next, true)
  })
}

async function saveAuxiliaryModelConnectionSettings(
  request: SaveAuxiliaryModelSettingsRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    const next = updateAuxiliaryModelSettings(loadAppConfig(), request)
    await persistConnectionConfig(next)
  })
}

async function saveConsensusModelConnectionSettings(
  request: SaveConsensusModelSettingsRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    const next = updateConsensusModelSettings(loadAppConfig(), request)
    await persistConnectionConfig(next, true)
  })
}

async function saveWebSearchConnectionSettings(
  request: SaveWebSearchSettingsRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    const next = updateWebSearchSettings(loadAppConfig(), request)
    await persistConnectionConfig(next)
  })
}

async function setMcpServerConnectionState(
  request: SetMcpServerEnabledRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(() =>
    updateMcpServerState({
      globalConfigPath: mcpGlobalConfigPath,
      projectDir: selectedRuntime().localProjectDir,
    }, request))
}

async function addMcpConnection(
  request: AddMcpServerRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(() =>
    addMcpConfiguredServer({
      globalConfigPath: mcpGlobalConfigPath,
      projectDir: selectedRuntime().localProjectDir,
    }, request))
}

async function authorizeMcpOAuthConnection(
  request: McpOAuthRequest,
): Promise<SettingsMutationResult> {
  if (sessionDeletionLock.sessionId || sessionPreparationLock.sessionId || sessionNavigation.sessionId) {
    return {
      ok: false,
      error: sessionDeletionLock.sessionId
        ? '会话数据删除中，请等待完成后再开始 MCP OAuth 登录'
        : sessionPreparationInProgressMessage('开始 MCP OAuth 登录'),
    }
  }
  if (settingsMutationInProgress) {
    return { ok: false, error: '连接设置正在保存，请完成后再开始 MCP OAuth 登录' }
  }
  try {
    const server = await resolveGlobalMcpHttpServer(request)
    await mcpOAuthController.authorize(server)
    return { ok: true, snapshot: await currentConnectionSettingsSnapshot() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function disconnectMcpOAuthConnection(
  request: McpOAuthRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    const server = await resolveGlobalMcpHttpServer(request)
    await mcpOAuthController.disconnect(server)
  })
}

async function saveMcpSecretHeaderConnection(
  request: SaveMcpSecretHeaderRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    if (!request.clearSecret && request.headerName.trim().toLowerCase() === 'authorization') {
      const server = await resolveGlobalMcpHttpServer(request)
      if (mcpOAuthController.currentSession(server)?.tokens) {
        throw new Error('当前 MCP 服务器已通过 OAuth 登录；请先退出登录，再改用 Authorization Header')
      }
    }
    const next = await updateMcpSecretHeader(
      {
        globalConfigPath: mcpGlobalConfigPath,
        projectDir: selectedRuntime().localProjectDir,
      },
      loadAppConfig(),
      request,
    )
    await persistConnectionConfig(next)
  })
}

async function mutateConnectionSettings(
  mutation: () => Promise<void>,
): Promise<SettingsMutationResult> {
  if (sessionDeletionLock.sessionId) {
    return { ok: false, error: '会话数据删除中，请等待完成后再修改连接设置' }
  }
  if (anyRuntimeBusy()) {
    return { ok: false, error: '当前有对话或其它操作进行中，请结束后再修改连接设置' }
  }
  if (mcpOAuthController.isAuthorizing()) {
    return { ok: false, error: 'MCP OAuth 登录进行中，请完成后再修改连接设置' }
  }
  settingsMutationInProgress = true
  try {
    await mutation()
    return { ok: true, snapshot: await currentConnectionSettingsSnapshot() }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    settingsMutationInProgress = false
    nudgeNotificationQueues()
  }
}

async function currentConnectionSettingsSnapshot(): Promise<ConnectionSettingsSnapshot> {
  const config = loadAppConfig()
  const runtime = selectedRuntime()
  const mcp = await createMcpSettingsSnapshot({
    globalConfigPath: mcpGlobalConfigPath,
    projectDir: runtime.localProjectDir,
    currentSessionSnapshot: runtime.session?.mcpSnapshot ?? null,
    mcpSecretHeaders: config?.mcpSecretHeaders ?? [],
    mcpOAuthController,
  })
  return createConnectionSettingsSnapshot(config, mcp)
}

async function resolveGlobalMcpHttpServer(request: McpOAuthRequest) {
  if (request.scope !== 'global') {
    throw new Error('项目 MCP 请使用项目环境变量认证，不能写入本机全局 OAuth 令牌库')
  }
  const appConfig = loadAppConfig()
  const configuration = await loadMcpConfiguration({
    globalConfigPath: mcpGlobalConfigPath,
    projectDir: selectedRuntime().localProjectDir,
    globalSecretHeaders: appConfig?.mcpSecretHeaders,
  })
  const server = configuration.servers.find((candidate) =>
    candidate.scope === 'global' && candidate.name === request.serverName)
  if (!server || server.transport !== 'http') {
    throw new Error(`已启用的全局 Streamable HTTP MCP 服务器不存在：${request.serverName}`)
  }
  return server
}

async function persistMcpOAuthSessions(
  oauthSessions: readonly NonNullable<WhycodeConfig['mcpOAuthSessions']>[number][],
): Promise<void> {
  const current = loadAppConfig() ?? { providers: {} }
  const next = structuredClone(current)
  if (oauthSessions.length > 0) next.mcpOAuthSessions = [...oauthSessions]
  else delete next.mcpOAuthSessions
  await saveConfig(next, configSecretCodec, getConfigPath())
}

function githubOAuthClientFromEnvironment(): {
  github?: McpRegisteredOAuthClient
} {
  const clientId = process.env.WHYCODE_GITHUB_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.WHYCODE_GITHUB_OAUTH_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return {}
  return {
    github: {
      clientId,
      clientSecret,
      tokenEndpointAuthMethod: 'client_secret_post',
    },
  }
}

async function openMcpConfigFile(
  request: OpenMcpConfigRequest,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const path = resolveMcpConfigPath(
      {
        globalConfigPath: mcpGlobalConfigPath,
        projectDir: selectedRuntime().localProjectDir,
      },
      request.scope,
    )
    if (request.scope === 'global') await ensureMcpConfigTemplate(path)
    else await ensureProjectMcpConfigTemplate(path)
    const error = await shell.openPath(path)
    return error ? { ok: false, error } : { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function recordUserInput(
  runtime: DesktopSessionRuntime,
  inputId: string,
  text: string,
  startsTurn: boolean,
  attachments: readonly ImageAttachment[] = [],
  imageDelivery: ImageDeliveryMode | undefined = undefined,
  consumesInputIds: readonly string[] = [],
  pdfAttachments: readonly PdfAttachment[] = [],
  skills: readonly ActivatedSkill[] = [],
): Promise<void> {
  const journal = runtime.journal
  if (!journal) throw new Error('会话记录尚未初始化，无法保存用户消息')
  await journal.recordUserInputWithId(
    inputId,
    text,
    startsTurn,
    attachments,
    consumesInputIds,
    pdfAttachments,
    skills,
    imageDelivery,
  )
}

function rejectUserMessage(
  runtime: DesktopSessionRuntime,
  message: string,
): RuntimeCommandResult {
  runtime.emit({ type: 'error', message, recoverable: true })
  if (!runtimeBusy(runtime)) {
    runtime.emit({ type: 'agent-status', status: 'idle' }, false)
  }
  return { ok: false, workspace: runtime.workspace }
}

async function runtimeSnapshot(
  runtime: DesktopSessionRuntime = selectedRuntime(),
  historyStart?: string,
): Promise<RuntimeSnapshot> {
  const journal = runtime.journal
  const resumingSessionId = sessionNavigation.sessionId
  const timeline = journal
    ? await runtime.timeline.conversationAt(journal, readRuntimeEventBoundary)
    : { state: createConversationState(), boundary: readRuntimeEventBoundary() }
  const busy = runtimeBusy(runtime)
  const checkpointRestoreToolUseId = runtime.checkpointRestoreToolUseId
  const deletingThisSession = Boolean(
    sessionDeletionLock.blocksSession(runtime.sessionId ?? undefined),
  )
  const backgroundTasks = journal
    ? await commandSessions.backgroundTasks(journal.sessionId)
    : null
  const subagentState = journal
    ? await subagents.state(journal.sessionId)
    : null
  return {
    runtimeId: runtime.runtimeId,
    workspace: runtime.workspace,
    modelId: resolveCurrentModelId(runtime),
    reasoningEffort: runtime.reasoningEffort,
    permissionMode: runtime.permissionMode,
    contextUsage: runtime.contextUsage ? structuredClone(runtime.contextUsage) : null,
    workStartedAt: runtime.workStartedAt,
    status: deletingThisSession
      ? 'working'
      : busy && runtime.status === 'idle' && !checkpointRestoreToolUseId
        ? 'working'
        : runtime.status,
    busy,
    checkpointRestoreToolUseId,
    deletingSessionId: deletingThisSession
      ? sessionDeletionLock.sessionId
      : null,
    resumingSessionId,
    sessionId: runtime.sessionId,
    history: conversationHistoryWindow(timeline.state, { from: historyStart }),
    queuedInputs: journal ? pendingInputs(journal, 'queued') : [],
    restoredInputs: journal ? pendingInputs(journal, 'restored') : [],
    approval: runtime.approval,
    eventSequence: timeline.boundary,
    forkOrigin: journal?.metadataSnapshot.forkOrigin ?? null,
    backgroundTasks,
    subagents: subagentState,
    activeSkills: runtime.session?.activeSkills ?? [],
    turnFileChanges: runtime.session?.turnFileChanges ?? [],
  }
}

/** 快照与实时流共享同一同步游标；批次不得横跨这个恢复边界。 */
function readRuntimeEventBoundary(): number {
  runtimeEventBatcher.flush()
  return runtimeEventSequence
}

/**
 * 完整快照与新会话工作区身份均就绪后才提交选择；失败候选交回既有卸载生命周期。
 */
async function selectRuntimeWithSnapshot(
  runtime: DesktopSessionRuntime,
): Promise<RuntimeSnapshot> {
  const previous = runtimeRegistry.selected
  let snapshot: RuntimeSnapshot
  try {
    snapshot = await runtimeSnapshot(runtime)
    workspaceLifecycle?.assertAvailable(localWorkspaceDirectory(runtime.workspace))
    if (!runtime.sessionId) {
      await newSessionState.set({ runtimeId: runtime.runtimeId, workspace: runtime.workspace })
    }
    runtimeRegistry.select(runtime)
  } catch (error) {
    if (runtimeRegistry.get(runtime.runtimeId) === runtime) {
      runtimeRegistry.runtimeBecameIdle(runtime)
    } else if (runtime.journal) {
      sessions.release(runtime.journal)
    }
    throw error
  }
  if (previous && previous !== runtime) {
    await runtimeRegistry.removeUnselectedDraft(previous)
  }
  return snapshot
}

let newSessionPending: Promise<NewSessionResult> | null = null
function startNewSession(request?: NewSessionRequest): Promise<NewSessionResult> {
  if (newSessionPending) return newSessionPending
  newSessionPending = prepareNewSession(request).finally(() => { newSessionPending = null })
  return newSessionPending
}

async function prepareNewSession(request?: NewSessionRequest): Promise<NewSessionResult> {
  if (sessionPreparationLock.sessionId || sessionNavigation.sessionId) {
    return {
      ok: false,
      error: sessionPreparationInProgressMessage('新建会话'),
    }
  }
  try {
    const replacedDraftRuntimeId = request?.workspace !== undefined ? newSessionState.value?.runtimeId ?? null : null
    const runtimeId = randomUUID()
    const runtime = request?.workspace === null
      ? createDraftRuntime(prepareDefaultRuntimeWorkspace(runtimeId, managedWorkspaces), runtimeId)
      : request?.workspace
        ? createDraftRuntime(await prepareRuntimeWorkspace(request.workspace, worktrees, sshWorkspaces))
        : await getNewSessionRuntime()
    const snapshot = await selectRuntimeWithSnapshot(runtime)
    const replaced = replacedDraftRuntimeId && runtimeRegistry.get(replacedDraftRuntimeId)
    if (replaced) await runtimeRegistry.removeUnselectedDraft(replaced)
    return { ok: true, snapshot, replacedDraftRuntimeId }
  } catch (error) {
    return {
      ok: false,
      error: `新建会话失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function resumeSession(sessionId: string, historyStart?: string): Promise<ResumeSessionResult> {
  if (sessionDeletionLock.blocksSession(sessionId) || sessionPreparationLock.kind === 'fork') {
    return {
      ok: false,
      error: sessionDeletionLock.blocksSession(sessionId)
        ? '会话数据删除中，请等待完成后再恢复会话'
        : sessionPreparationInProgressMessage('恢复其它会话'),
    }
  }
  return sessionNavigation.resume(sessionId, historyStart)
}

async function forkSession(value: unknown): Promise<ForkSessionResult> {
  let request: ForkSessionRequest
  try {
    request = parseForkSessionRequest(value)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  if (sessionDeletionLock.sessionId || sessionPreparationLock.sessionId || sessionNavigation.sessionId) {
    return {
      ok: false,
      error: sessionDeletionLock.sessionId
        ? '会话数据删除中，请等待完成后再创建分支'
        : sessionPreparationInProgressMessage('创建会话分支'),
    }
  }
  const sourceRuntime = runtimeRegistry.findBySessionId(request.sourceSessionId)
  const release = sessionPreparationLock.acquire(request.sourceSessionId, 'fork')
  if (!release) {
    return { ok: false, error: sessionPreparationInProgressMessage('创建会话分支') }
  }
  let sourceJournal: SessionJournal | null = null
  let forkedJournal: SessionJournal | null = null
  let runtime: DesktopSessionRuntime | null = null
  try {
    if (sourceRuntime) await sourceRuntime.timeline.flush()
    sourceJournal = sourceRuntime?.journal
      ?? await sessions.prepareResume(request.sourceSessionId)
    const sourceWorkspace = sourceJournal.metadataSnapshot.workspace
    const remote = await sshWorkspaces.connect(sourceWorkspace)
    if (sourceWorkspace.mode === 'managed') {
      await managedWorkspaces.assertUsable(sourceWorkspace, sourceJournal.sessionId)
    }
    forkedJournal = await sessions.fork(
      sourceJournal, request.sourceTurnId, remote
        ? posix.dirname(sshScratchPaths(remote.home, sourceJournal.sessionId).rootDirectory)
        : sessionScratch.rootDirectory,
    )
    if (remote) await sshWorkspaces.snapshot(sourceWorkspace, sourceJournal.sessionId, forkedJournal.sessionId)
    else await sessionScratch.snapshot(sourceJournal.sessionId, forkedJournal.sessionId)
    await attachSessionWorkspace(forkedJournal)
    await projects.inheritSession(sourceJournal.sessionId, forkedJournal.sessionId)
    runtime = await prepareRuntimeFromJournal(forkedJournal)
    return { ok: true, snapshot: await selectRuntimeWithSnapshot(runtime) }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    if (runtime && runtimeRegistry.get(runtime.runtimeId) === runtime && !runtime.isDisposed) {
      await runtimeRegistry.remove(runtime).catch(() => {})
    }
    if (forkedJournal) {
      await projects.detachSession(forkedJournal.sessionId)
        .catch((rollbackError) => rollbackErrors.push(rollbackError))
      await (forkedJournal.metadataSnapshot.workspace.mode === 'ssh'
        ? sshWorkspaces.removeScratch(forkedJournal.sessionId, forkedJournal.metadataSnapshot.workspace)
        : sessionScratch.remove(forkedJournal.sessionId))
        .catch((rollbackError) => rollbackErrors.push(rollbackError))
      await removeForkSessionWorkspace(forkedJournal)
        .catch((rollbackError) => rollbackErrors.push(rollbackError))
      await sessions.markDeleting(forkedJournal.sessionId)
        .catch((rollbackError) => rollbackErrors.push(rollbackError))
      await sessions.delete(forkedJournal.sessionId)
        .catch((rollbackError) => rollbackErrors.push(rollbackError))
    }
    if (rollbackErrors.length > 0) {
      return {
        ok: false,
        error: `创建会话分支失败且自动回滚未完成：${
          rollbackErrors.map((rollbackError) =>
            rollbackError instanceof Error ? rollbackError.message : String(rollbackError))
            .join('；')
        }`,
      }
    }
    return {
      ok: false,
      error: `创建会话分支失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    if (!sourceRuntime && sourceJournal) sessions.release(sourceJournal)
    release()
    nudgeNotificationQueues()
  }
}

function parseForkSessionRequest(value: unknown): ForkSessionRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('创建会话分支的请求格式无效')
  }
  const request = value as Record<string, unknown>
  if (
    Object.keys(request).length !== 2
    || typeof request.sourceSessionId !== 'string'
    || typeof request.sourceTurnId !== 'string'
    || request.sourceTurnId.length === 0
  ) {
    throw new Error('创建会话分支的请求格式无效')
  }
  validateSessionId(request.sourceSessionId)
  return {
    sourceSessionId: request.sourceSessionId,
    sourceTurnId: request.sourceTurnId,
  }
}

async function prepareResumedRuntime(sessionId: string): Promise<DesktopSessionRuntime> {
  const preparation = await sessions.preparations.read(sessionId)
  if (preparation) {
    const workspace = await restoreSubmittedWorkspace(sessionId, preparation.workspace,
      worktrees, managedWorkspaces, binding => sessions.preparations.updateWorkspace(sessionId, binding))
    const runtime = new DesktopSessionRuntime({
      runtimeId: sessionId,
      workspace,
      modelId: preparation.modelId,
      reasoningEffort: preparation.reasoningEffort,
      permissionMode: preferredPermissionMode,
      emit: broadcastRuntimeEvent,
    })
    runtime.registerSession()
    runtime.workspaceIO = sshWorkspaces.io(runtime.workspace)
    runtime.consensusEnabled = runtime.workspace.mode === 'ssh' ? false : preferredConsensusEnabled
    return runtime
  }
  const journal = await sessions.prepareResume(sessionId)
  await journal.recoverInterruptedWork()
  return prepareRuntimeFromJournal(journal)
}

async function prepareRuntimeFromJournal(
  journal: SessionJournal,
): Promise<DesktopSessionRuntime> {
  const metadata = journal.metadataSnapshot
  const resolved = resolveModelConnection(loadDisplayConfig(), metadata.modelId)
  const targetReasoningEffort = resolved.ok
    ? normalizeReasoningEffortSelection(
        resolved.value.entry.capabilities,
        metadata.reasoningEffort,
      )
    : metadata.reasoningEffort
  const runtime = new DesktopSessionRuntime({
    workspace: metadata.workspace,
    modelId: metadata.modelId,
    reasoningEffort: targetReasoningEffort,
    permissionMode: preferredPermissionMode,
    emit: broadcastRuntimeEvent,
  })
  const targetProjectDir = requireRuntimeProjectDir(runtime)
  runtime.workspaceIO = sshWorkspaces.io(runtime.workspace)
  runtime.consensusEnabled = runtime.workspace.mode === 'ssh' ? false : preferredConsensusEnabled
  runtime.journal = journal
  try {
    if (metadata.workspace.mode === 'worktree') {
      await worktrees.assertUsable(
        metadata.workspace,
        journal.sessionId,
        runtime.runtimeId,
      )
    } else if (metadata.workspace.mode === 'managed') {
      await managedWorkspaces.assertUsable(metadata.workspace, journal.sessionId)
    }
    if (metadata.workspace.mode !== 'ssh') await sessionScratch.ensure(journal.sessionId)
    if (resolved.ok && metadata.workspace.mode !== 'ssh') {
      runtime.session = await createMainAgentSession(
        runtime,
        journal,
        targetProjectDir,
        resolved.value.entry,
        resolved.value.providerConfig,
        targetReasoningEffort,
      )
    }
    if (runtime.consensusEnabled && runtime.session) {
      const built = createCoordinator(
        runtime,
        runtime.session,
        journal,
        targetProjectDir,
        sessionScratch.paths(journal.sessionId).rootDirectory,
      )
      if (!built.ok) throw new Error(built.error)
      runtime.coordinator = built.value
    }
  } catch (error) {
    await runtime.dispose().catch(() => {})
    if (metadata.workspace.mode === 'worktree') {
      worktrees.release(metadata.workspace, runtime.runtimeId)
    }
    sessions.release(journal)
    throw error
  }
  return runtime
}

async function attachSessionWorkspace(journal: SessionJournal): Promise<void> {
  const workspace = journal.metadataSnapshot.workspace
  if (workspace.mode === 'worktree') await worktrees.attachSession(workspace, journal.sessionId)
  if (workspace.mode === 'managed') await managedWorkspaces.attachSession(workspace, journal.sessionId)
}

async function removeForkSessionWorkspace(journal: SessionJournal): Promise<void> {
  const workspace = journal.metadataSnapshot.workspace
  if (workspace.mode === 'worktree') {
    await worktrees.detachSession(workspace, journal.sessionId, { deleteDirectory: false, name: '未完成的 Fork', protectDirectory: true })
  }
  if (workspace.mode === 'managed') {
    await managedWorkspaces.detachSession(workspace, journal.sessionId)
  }
}

async function resolveBackgroundTaskRuntime(
  sessionId: string,
): Promise<BackgroundTaskRuntimeResolution> {
  if (sessionDeletionLock.sessionId === sessionId) return { kind: 'defer' }
  if (settingsMutationInProgress || sessionPreparationLock.sessionId || sessionNavigation.sessionId) return { kind: 'defer' }

  const existing = runtimeRegistry.findBySessionId(sessionId)
  if (existing) {
    const error = await ensureSession(existing)
    if (error) return { kind: 'defer' }
    return existing.session
      ? { kind: 'ready', runtime: existing }
      : { kind: 'defer' }
  }

  const summary = (await sessions.list()).find((item) => item.sessionId === sessionId)
  if (!summary || !summary.resumable) return { kind: 'drop' }
  const release = sessionPreparationLock.acquire(sessionId)
  if (!release) return { kind: 'defer' }
  try {
    const runtime = await prepareResumedRuntime(sessionId)
    runtimeRegistry.add(runtime)
    return { kind: 'ready', runtime }
  } catch (error) {
    console.warn(
      `后台任务已结束，但所属会话暂未恢复：${error instanceof Error ? error.message : String(error)}`,
    )
    return { kind: 'defer' }
  } finally {
    release()
  }
}

function internalNotificationDeliveryBlocked(runtime: DesktopSessionRuntime): boolean {
  return Boolean(
    runtime.isDisposed
    || !runtime.session
    || runtime.session.waitingForUserInput
    || runtime.coordinator?.busy
    || (runtime.sessionId && sessionDeletionLock.blocksSession(runtime.sessionId))
  )
}

function deliverBackgroundTaskNotification(
  runtime: DesktopSessionRuntime,
  notification: Parameters<AgentSession['handleTaskNotification']>[0],
): void {
  const session = runtime.session
  if (!session) throw new Error('后台任务所属会话尚未建立 Agent')
  synchronizeRuntimeAuxiliaryImageAnalyzer(runtime, loadAppConfig())
  let handling: ReturnType<AgentSession['handleTaskNotification']>
  try {
    handling = session.handleTaskNotification(notification)
  } catch (error) {
    reportBackgroundTaskDeliveryError(runtime, error)
    return
  }
  if (handling) runtime.beginWork()
  void Promise.resolve(handling).catch((error) =>
    reportBackgroundTaskDeliveryError(runtime, error))
}

function reportBackgroundTaskDeliveryError(
  runtime: DesktopSessionRuntime,
  error: unknown,
): void {
  runtime.emit({
    type: 'error',
    message: `后台任务完成通知未能交给 Agent：${error instanceof Error ? error.message : String(error)}`,
    recoverable: true,
  })
  runtime.emit({ type: 'agent-status', status: 'error' }, false)
}

function deliverSubagentSettlement(
  runtime: DesktopSessionRuntime,
  notification: SubagentSettlementNotification,
): void {
  const session = runtime.session
  if (!session) throw new Error('子代理所属父会话尚未建立 Agent')
  synchronizeRuntimeAuxiliaryImageAnalyzer(runtime, loadAppConfig())
  let handling: ReturnType<AgentSession['handleSubagentSettlement']>
  try {
    handling = session.handleSubagentSettlement(
      notification,
      () => subagents.markSettlementDelivered(notification),
    )
  } catch (error) {
    reportSubagentDeliveryError(runtime, error)
    return
  }
  if (handling) runtime.beginWork()
  void Promise.resolve(handling).catch((error) => reportSubagentDeliveryError(runtime, error))
}

function reportSubagentDeliveryError(
  runtime: DesktopSessionRuntime,
  error: unknown,
): void {
  runtime.emit({
    type: 'error',
    message: `子代理终态未能交给父 Agent：${error instanceof Error ? error.message : String(error)}`,
    recoverable: true,
  })
  runtime.emit({ type: 'agent-status', status: 'error' }, false)
}

function pendingInputs(
  journal: SessionJournal,
  state: 'queued' | 'restored',
): {
  id: string
  text: string
  attachments?: ImageAttachment[]
  pdfAttachments?: PdfAttachment[]
  skills?: ReturnType<typeof skillSummary>[]
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
      ...(input.skills?.length ? { skills: input.skills.map(skillSummary) } : {}),
    }))
}

async function deleteSession(sessionId: string, options: DeleteSessionOptions): Promise<DeleteSessionResult> {
  const targetRuntime = runtimeRegistry.findBySessionId(sessionId)
  if (
    sessionDeletionLock.sessionId
    || sessionPreparationLock.sessionId
    || sessionNavigation.sessionId
    || mcpOAuthController.isAuthorizing()
    || targetRuntime?.busy
  ) {
    return {
      ok: false,
      error: sessionDeletionLock.sessionId
        ? '已有会话正在删除，请等待完成'
        : sessionPreparationLock.sessionId || sessionNavigation.sessionId
          ? sessionPreparationInProgressMessage('删除会话')
        : mcpOAuthController.isAuthorizing()
          ? mcpOAuthInProgressMessage('删除会话')
          : targetRuntime?.checkpointRestoreToolUseId
            ? '文件回滚中，请等待完成后再删除会话'
            : '目标会话仍在工作，请先停止再删除',
    }
  }
  let detachedCurrent = false
  let replacementRuntime: DesktopSessionRuntime | null = null
  const deletionLease = sessionDeletionLock.acquire(sessionId)
  if (!deletionLease) return { ok: false, error: '已有会话正在删除，请等待完成' }
  let cleanupStarted = false
  try {
    const summary = targetRuntime
      ? null
      : (await sessions.list()).find((item) => item.sessionId === sessionId)
    if (!targetRuntime && !summary) return { ok: false, error: '会话不存在' }
    const targetWorkspace = runtimeWorkspaceBinding(targetRuntime?.workspace ?? summary?.workspace)
    if (!options || typeof options.deleteDirectory !== 'boolean'
      || !['required', 'skip'].includes(options.remoteCleanup)) throw new Error('删除会话选项无效')
    const { deleteDirectory, remoteCleanup } = options
    if (remoteCleanup === 'skip' && targetWorkspace?.mode !== 'ssh') throw new Error('仅 SSH 会话可跳过远端清理')
    if (deleteDirectory) {
      const preview = await workspaceLifecycle.preview(sessionId, targetWorkspace)
      if (['local', 'remote', 'shared', 'unverified'].includes(preview.disposition)) {
        throw new Error('工作目录无法删除或仍被其它会话使用，请重新确认')
      }
    }
    const workspaceName = sessionSidebarState.name(sessionId)
      ?? targetRuntime?.journal?.metadataSnapshot.title ?? summary?.title ?? '保留的工作区'
    const deletion = await stageSessionDeletion({
      sessionId,
      sessions,
      commandSessions,
      scratch: sessionScratch,
      onBeforeMarkDeleting: async () => {
        terminals.closeOwner({ sessionId })
        await commandSessions.stopSession(sessionId)
        if (remoteCleanup === 'required') await sshWorkspaces.removeScratch(sessionId, targetWorkspace)
      },
      onBeforeArtifactsDelete: async () => {
        await subagents.forgetParent(sessionId)
        if (targetRuntime) await runtimeRegistry.remove(targetRuntime)
      },
      onBeforeFactSourceDelete: async () => {
        const warning = await workspaceLifecycle.release(
          sessionId, targetWorkspace, workspaceName, deleteDirectory,
        )
        await syncRetiredModelLabels(sessionId)
        return remoteCleanup === 'skip' ? '服务器上的会话临时文件已保留' : warning
      },
    })
    if (!deletion.sessionExists) {
      return { ok: false, error: '会话不存在' }
    }
    backgroundTaskWakeups?.discardSession(sessionId)
    subagentWakeups?.discardSession(sessionId)
    if (runtimeRegistry.selected?.sessionId === sessionId) {
      const replacement = await getNewSessionRuntime()
      // 远端清理期间可以切换会话；迟到的删除结果不能覆盖用户的新选择。
      if (runtimeRegistry.selected?.sessionId === sessionId) {
        replacementRuntime = replacement
        runtimeRegistry.select(replacement)
        detachedCurrent = true
      }
    }

    cleanupStarted = true
    void deletion.finish().then(async (result) => {
      if (!result.deleted) throw new Error('会话删除状态已丢失')
      runtimeRegistry.forgetSession(sessionId)
      const sidebarCleanup = await Promise.allSettled([
        sessionSidebarState.remove(sessionId),
        targetWorkspace?.mode === 'ssh'
          ? sshWorkspaces.connections.configuredTargets().then(targets => projects.detachSession(sessionId, new Set(targets.keys())))
          : projects.detachSession(sessionId),
      ])
      for (const cleanup of sidebarCleanup) {
        if (cleanup.status === 'rejected') console.warn('会话已删除，但侧栏信息清理失败：', cleanup.reason)
      }
      broadcastSessionDeletion({ sessionId, status: 'completed', warning: result.warning })
    }).catch((error) => {
      broadcastSessionDeletion({
        sessionId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }).finally(() => deletionLease.release())

    return {
      ok: true,
      deletedCurrent: detachedCurrent,
      cleanupPending: true,
      ...(replacementRuntime
        ? { snapshot: await runtimeSnapshot(replacementRuntime) }
        : {}),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof SshScratchCleanupError ? { remoteCleanupFailure: error.failure } : {}),
      deletedCurrent: detachedCurrent || undefined,
      ...(replacementRuntime
        ? { snapshot: await runtimeSnapshot(replacementRuntime) }
        : {}),
    }
  } finally {
    if (!cleanupStarted) {
      deletionLease.release()
      nudgeNotificationQueues()
    }
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
  await migrateLegacyConfig(configSecretCodec, getConfigPath())
    .catch((error) => console.error('配置安全迁移失败：', error))
  preferredPermissionMode = loadDisplayConfig()?.permissionMode ?? 'default'
  await ensureCustomSystemPromptTemplate(customSystemPromptConfigPath)
    .catch((error) => console.warn('自定义 System 模板初始化失败：', error))
  await ensureMcpConfigTemplate(mcpGlobalConfigPath)
    .catch((error) => console.warn('MCP 配置模板初始化失败：', error))
  await installSystemSkills(app.getPath('home'))
    .catch((error) => console.warn('内置 Skill 初始化失败：', error))
  await synchronizeConfiguredCliProxyRoutes()
    .catch((error) => console.warn('CLIProxyAPI 模型目录同步失败：', error))
  // 旧命令快照已退出事实源，可以在启动时安全清理；会话 scratch 由下方按事实源定向回收。
  void rm(join(app.getPath('userData'), 'checkpoints'), { recursive: true, force: true })
    .catch(() => {})
  try {
    defaultWorkspaceDir = await ensureDefaultWorkspace(
      app.getPath('documents'),
      app.getPath('userData'),
    )
  } catch (error) {
    dialog.showErrorBox(
      'WhyCode 启动失败',
      error instanceof Error ? error.message : '无法创建默认工作文件夹',
    )
    app.quit()
    return
  }
  const sessionsRoot = join(app.getPath('userData'), 'sessions')
  sessions = new DesktopSessionRepository(sessionsRoot, pdfProcessor)
  sessionSidebarState = new SessionSidebarStateStore(
    join(app.getPath('userData'), 'session-sidebar.json'),
  )
  sshWorkspaces = new SshWorkspaces(new SshConnections(
    new SshConnectionStore(join(app.getPath('userData'), 'ssh-connections.json'), configSecretCodec),
    join(app.getAppPath(), 'resources', 'remote'),
  ))
  sshWorkspaces.connections.on('changed', () => broadcastToWindows(IPC.sshChanged, undefined, 'SSH 状态推送失败：'))
  projects = new ProjectStore(join(app.getPath('userData'), 'projects.json'))
  try { await projects.initialize() }
  catch (error) {
    dialog.showErrorBox('项目记录读取失败', error instanceof Error ? error.message : String(error))
    app.quit()
    return
  }
  sessionScratch = new SessionScratchManager(join(app.getPath('userData'), 'scratch'))
  skills = new SkillCatalogService({ homeDir: app.getPath('home') })
  subagentDefinitions = new SubagentDefinitionCatalogService({ homeDir: app.getPath('home') })
  worktrees = new WorktreeManager(join(dirname(getConfigPath()), 'worktrees'))
  managedWorkspaces = new ManagedWorkspaceManager(
    requireDefaultWorkspace(),
    join(dirname(getConfigPath()), 'managed-workspaces'),
  )
  newSessionState = new NewSessionStateStore(join(app.getPath('userData'), 'new-session.json'))
  try {
    await newSessionState.initialize()
    const registeredIds = new Set((await sessions.list()).map(item => item.sessionId))
    if (newSessionState.value && registeredIds.has(newSessionState.value.runtimeId)) {
      await newSessionState.consume(newSessionState.value.runtimeId)
    }
    const savedDraft = newSessionState.value
    if (savedDraft) {
      const { runtimeId, workspace } = savedDraft
      const binding = workspace.mode === 'managed' || workspace.mode === 'pending-managed'
        ? await managedWorkspaces.restoreDraft(runtimeId)
        : workspace.mode === 'worktree' || workspace.mode === 'pending-worktree'
          ? await worktrees.restoreDraft(runtimeId, runtimeId)
          : null
      if (binding) await newSessionState.set({ runtimeId, workspace: binding })
      else if (workspace.mode === 'managed' || workspace.mode === 'worktree') {
        throw new Error('新会话工作区已不存在，无法恢复草稿目录')
      }
    }
  } catch (error) {
    dialog.showErrorBox('WhyCode 启动失败', `无法恢复新会话草稿目录：${error instanceof Error ? error.message : String(error)}`)
    app.quit()
    return
  }
  await worktrees.pruneEmptyRepositoryDirectories()
    .catch((error) => console.warn('Worktree 空仓库目录清理失败：', error))
  try {
    const summaries = await sessions.list()
    for (const summary of summaries) {
      if (!('preparing' in summary)) continue
      try {
        summary.workspace = await restoreSubmittedWorkspace(summary.sessionId, summary.workspace,
          worktrees, managedWorkspaces, binding => sessions.preparations.updateWorkspace(summary.sessionId, binding))
        if (summary.workspace.mode === 'worktree') worktrees.release(summary.workspace, summary.sessionId)
      } catch (error) {
        console.warn('会话准备目录恢复失败：', error)
      }
    }
    await sessionSidebarState.initialize(new Set(summaries.map((summary) => summary.sessionId)))
    const protectedDirectories = [
      ...summaries.flatMap(item => item.workspace ? [localWorkspaceDirectory(item.workspace)] : []),
      newSessionState.value ? localWorkspaceDirectory(newSessionState.value.workspace) : null,
    ].filter((directory): directory is string => directory !== null)
    const worktreeCleanup = await worktrees.cleanupAbandonedDrafts(
      new Set(summaries.flatMap((summary) =>
        summary.workspace?.mode === 'worktree' ? [summary.workspace.id]
          : summary.workspace?.mode === 'pending-worktree' ? [summary.sessionId] : [],
      ).concat(newSessionState.value ? [newSessionState.value.runtimeId] : [])),
      protectedDirectories,
    )
    const managedCleanup = await managedWorkspaces.cleanupAbandoned(
      summaries.map(summary => ({ sessionId: summary.sessionId, workspace: runtimeWorkspaceBinding(summary.workspace) })),
      new Set(summaries.filter(item => item.workspace?.mode === 'pending-managed').map(item => item.sessionId)
        .concat(newSessionState.value ? [newSessionState.value.runtimeId] : [])),
      protectedDirectories,
    )
    const scratchCleanup = await sessionScratch.cleanupAbandoned(
      new Set(summaries.map((summary) => summary.sessionId)),
    )
    if (worktreeCleanup.removed.length) {
      console.info(`已清理 ${worktreeCleanup.removed.length} 个无会话的干净 Worktree 草稿`)
    }
    if (worktreeCleanup.retained.length) {
      console.warn(`已保留 ${worktreeCleanup.retained.length} 个含成果或状态不可确认的 Worktree 草稿`)
    }
    for (const warning of worktreeCleanup.warnings) {
      console.warn(`Worktree 草稿清理跳过：${warning}`)
    }
    if (managedCleanup.removed.length) {
      console.info(`已清理 ${managedCleanup.removed.length} 个无会话的默认工作区`)
    }
    for (const warning of managedCleanup.warnings) {
      console.warn(`默认工作区清理跳过：${warning}`)
    }
    if (scratchCleanup.removed.length) {
      console.info(`已清理 ${scratchCleanup.removed.length} 个无会话的临时工作区`)
    }
    for (const warning of scratchCleanup.warnings) {
      console.warn(`会话临时工作区清理跳过：${warning}`)
    }
  } catch (error) {
    console.warn('受管资源启动清理失败：', error)
  }
  runtimeRegistry = new SessionRuntimeRegistry({
    onDisposeError: (error) => console.error('会话运行时清理失败：', error),
    retainDraft: (runtime) => newSessionState.value?.runtimeId === runtime.runtimeId,
    onRemoved: async (runtime) => {
      workspaceFiles.closeRuntime(runtime.runtimeId)
      if (!runtime.sessionId) terminals.closeOwner({ runtimeId: runtime.runtimeId })
      if (runtime.journal) sessions.release(runtime.journal)
      if (!runtime.sessionId && newSessionState.value?.runtimeId === runtime.runtimeId) return
      const workspace = runtime.workspaceBinding
      if (workspace?.mode === 'worktree' && runtime.sessionId) {
        worktrees.release(workspace, runtime.runtimeId)
      } else if (workspace?.mode === 'worktree') {
        await worktrees.cleanupDraft(workspace, runtime.runtimeId,
          await workspaceLifecycle?.isReferenced(workspace.worktreeDirectory) ?? false)
      } else if (workspace?.mode === 'managed' && !runtime.sessionId) {
        await managedWorkspaces.remove(workspace,
          await workspaceLifecycle?.isReferenced(workspace.workingDirectory) ?? false)
      }
    },
  })
  const initialRuntime = await getNewSessionRuntime()
  runtimeRegistry.select(initialRuntime)
  await syncRetiredModelLabels()
    .catch((error) => console.warn('历史模型显示名同步失败：', error))
  registerAttachmentProtocol(async (sessionId) => {
    const journal = runtimeRegistry.findBySessionId(sessionId)?.journal
    if (journal) return journal.attachmentDirectory
    for (const runtime of runtimeRegistry.all()) {
      if (!runtime.journal) continue
      const directory = await subagents.attachmentDirectory(runtime.journal.sessionId, sessionId)
        .catch(() => null)
      if (directory) return directory
    }
    return null
  })
  protocol.handle(SITE_ICON_SCHEME, createSiteIconHandler({
    fetchImpl: createElectronWebPageFetch(options => net.request(options)),
    resolveHost: createElectronWebHostResolver((hostname, options) => net.resolveHost(hostname, options)),
  }))
  backgroundTaskWakeups = new BackgroundTaskWakeQueue({
    resolveRuntime: resolveBackgroundTaskRuntime,
    reserveWorkStart: (runtime) => runtimeRegistry.reserveWorkStart(runtime),
    deliveryBlocked: internalNotificationDeliveryBlocked,
    deliver: deliverBackgroundTaskNotification,
    onError: (error) => console.error('后台任务完成通知调度失败：', error),
  })
  subagents = new SubagentService({
    sessionsRoot,
    scratch: sessionScratch,
    definitions: subagentDefinitions,
    skills,
    webSearchTool,
    createWebPageTools: createSessionWebPageTools,
    selectModel: (parent: SubagentModelSnapshot) =>
      resolveSubagentModelSelection(loadAppConfig(), parent),
    resolveModel: (modelId) => {
      const resolved = resolveModelConnection(loadAppConfig(), modelId)
      return resolved.ok ? resolved.value : null
    },
    pdfProcessor,
    officeProcessor,
    captureScreenshot: captureSessionScreenshot,
    hostOperations,
    onState: broadcastSubagents,
    onEvent: broadcastSubagentEvent,
    onSettlement: (notification) => subagentWakeups?.enqueue(notification),
    onParentIdle: (runtime) => {
      runtimeRegistry.runtimeBecameIdle(runtime)
      nudgeNotificationQueues()
    },
    onError: (error) => console.error('子代理运行失败：', error),
  })
  subagentWakeups = new SessionNotificationWakeQueue({
    key: (notification) => `${notification.parentSessionId}:${notification.activationId}`,
    sessionId: (notification) => notification.parentSessionId,
    resolveRuntime: resolveBackgroundTaskRuntime,
    reserveWorkStart: (runtime) => runtimeRegistry.reserveWorkStart(runtime),
    deliveryBlocked: internalNotificationDeliveryBlocked,
    deliver: deliverSubagentSettlement,
    onDrop: (notification) => subagents.markSettlementDelivered(notification),
    onError: (error) => console.error('子代理终态通知调度失败：', error),
  })
  commandSessions = new CommandSessionManager(
    join(app.getPath('userData'), 'command-tasks'),
    {
      onBackgroundTaskTerminal: (notification) =>
        backgroundTaskWakeups?.enqueue(notification),
      onBackgroundTasksChanged: broadcastBackgroundTasks,
    },
  )
  await commandSessions.initialize()
  await subagents.initialize()
  ipcMain.on(IPC.runtimeEventPortRequest, (event) => {
    if (event.senderFrame !== event.sender.mainFrame) return
    provideRuntimeEventPort(event.sender)
  })
  ipcMain.handle(IPC.command, (_e, envelope: RuntimeCommandEnvelope) => {
    if (
      !envelope
      || typeof envelope.runtimeId !== 'string'
      || !envelope.command
    ) return { ok: false }
    const runtime = runtimeRegistry.get(envelope.runtimeId)
    if (!runtime) return { ok: false }
    return handleCommand(runtime, envelope.command)
  })
  ipcMain.handle(IPC.listModels, async (_e, runtimeId?: string) => {
    await synchronizeConfiguredCliProxyRoutes()
      .catch((error) => console.warn('CLIProxyAPI 模型目录同步失败：', error))
    const runtime = runtimeForId(runtimeId)
    return listModelConnections(loadAppConfig(), resolveCurrentModelId(runtime))
  })
  ipcMain.handle(IPC.listSkills, async (_e, runtimeId?: string) => {
    const runtime = runtimeForId(runtimeId)
    if (runtime.workspace.mode === 'ssh' && !sshWorkspaces.connections.isTargetConnected(runtime.workspace.target)) {
      return { revision: 'disconnected', skills: [], diagnostics: [{ path: '', message: '连接 SSH 后可使用远端 Skill' }], modelContext: null, omittedCount: 0 }
    }
    const modelId = resolveCurrentModelId(runtime)
    const resolved = modelId
      ? resolveModelConnection(loadAppConfig(), modelId)
      : null
    const contextWindow = resolved?.ok
      ? resolved.value.entry.capabilities.contextWindow
      : undefined
    // pending-worktree 尚未创建真实目录；此时目录只展示用户级与内置 Skill，避免签发
    // 指向源仓库、却要在首条消息创建后的 Worktree 中校验的失效 locator。
    return (await skillCatalogFor(runtime)).list(runtime.projectDir, contextWindow)
  })
  ipcMain.handle(IPC.mcpStatus, (_e, runtimeId: string) => {
    const runtime = runtimeForId(runtimeId)
    return createMcpStatusSnapshot({
      globalConfigPath: mcpGlobalConfigPath,
      projectDir: runtime.localProjectDir,
      currentSessionSnapshot: runtime.session?.mcpSnapshot ?? null,
      mcpSecretHeaders: loadAppConfig()?.mcpSecretHeaders ?? [],
    })
  })
  ipcMain.handle(IPC.connectionSettings, async () => {
    if (!mcpOAuthController.isAuthorizing()) {
      await synchronizeConfiguredCliProxyRoutes()
        .catch((error) => console.warn('CLIProxyAPI 模型目录同步失败：', error))
    }
    return currentConnectionSettingsSnapshot()
  })
  ipcMain.handle(IPC.saveProviderSettings, (_e, request: SaveProviderSettingsRequest) =>
    saveProviderModelSettings(request))
  ipcMain.handle(IPC.saveCliProxyApiSettings, (_e, request: SaveCliProxyApiSettingsRequest) =>
    saveCliProxyApiConnectionSettings(request))
  ipcMain.handle(
    IPC.saveAuxiliaryModelSettings,
    (_e, request: SaveAuxiliaryModelSettingsRequest) =>
      saveAuxiliaryModelConnectionSettings(request),
  )
  ipcMain.handle(
    IPC.saveConsensusModelSettings,
    (_e, request: SaveConsensusModelSettingsRequest) =>
      saveConsensusModelConnectionSettings(request),
  )
  ipcMain.handle(IPC.saveWebSearchSettings, (_e, request: SaveWebSearchSettingsRequest) =>
    saveWebSearchConnectionSettings(request))
  ipcMain.handle(IPC.setMcpServerEnabled, (_e, request: SetMcpServerEnabledRequest) =>
    setMcpServerConnectionState(request))
  ipcMain.handle(IPC.addMcpServer, (_e, request: AddMcpServerRequest) =>
    addMcpConnection(request))
  ipcMain.handle(IPC.saveMcpSecretHeader, (_e, request: SaveMcpSecretHeaderRequest) =>
    saveMcpSecretHeaderConnection(request))
  ipcMain.handle(IPC.authorizeMcpOAuth, (_e, request: McpOAuthRequest) =>
    authorizeMcpOAuthConnection(request))
  ipcMain.handle(IPC.disconnectMcpOAuth, (_e, request: McpOAuthRequest) =>
    disconnectMcpOAuthConnection(request))
  ipcMain.handle(IPC.openMcpConfig, (_e, request: OpenMcpConfigRequest) =>
    openMcpConfigFile(request))
  ipcMain.handle(IPC.conversationHistory, async (_e, request: ConversationHistoryRequest): Promise<ConversationHistoryResult> => {
    try {
      const runtime = runtimeForId(request.runtimeId)
      if (!runtime.journal) throw new Error('当前会话没有更早历史')
      const { state } = await runtime.timeline.conversationAt(runtime.journal, readRuntimeEventBoundary)
      return { ok: true, history: conversationHistoryWindow(state, request) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.runtimeSnapshot, (_e, runtimeId?: string) =>
    runtimeSnapshot(runtimeForId(runtimeId)))
  ipcMain.handle(IPC.subagentTranscript, (
    _e,
    parentSessionId: string,
    subagentId: string,
  ) => subagents.transcript(parentSessionId, subagentId))
  ipcMain.handle(IPC.checkpointFileChanges, (
    _e, request: CheckpointFileChangesRequest,
  ): Promise<CheckpointFileChangesResult> => {
    if (!request || typeof request.runtimeId !== 'string' || !Array.isArray(request.checkpointIds)
      || !request.checkpointIds.every(id => typeof id === 'string')) {
      return Promise.resolve({ ok: false, error: '文件改动请求无效' })
    }
    return readCheckpointFileChanges(runtimeRegistry.get(request.runtimeId), request.checkpointIds, sessionScratch.rootDirectory)
  })
  ipcMain.handle(IPC.checkpointFilePreview, (
    _e,
    request: CheckpointFilePreviewRequest,
  ): Promise<CheckpointFilePreviewResult> => {
    if (
      !request
      || typeof request.runtimeId !== 'string'
      || typeof request.path !== 'string'
    ) return Promise.resolve({ ok: false, error: '文件预览请求无效' })
    const target = typeof request.toolUseId === 'string' && request.checkpointIds === undefined ? request.toolUseId
      : request.toolUseId === undefined && Array.isArray(request.checkpointIds) && request.checkpointIds.length > 0
        && request.checkpointIds.every(id => typeof id === 'string') ? request.checkpointIds : null
    if (target === null) return Promise.resolve({ ok: false, error: '文件预览请求无效' })
    return readCheckpointFilePreview(runtimeRegistry.get(request.runtimeId), target, request.path)
  })
  ipcMain.handle(IPC.checkpointFileCurrentMatch, (
    _e,
    request: CheckpointFileCurrentMatchRequest,
  ): Promise<CheckpointFileCurrentMatchResult> => {
    if (
      !request
      || typeof request.runtimeId !== 'string'
      || typeof request.toolUseId !== 'string'
      || typeof request.path !== 'string'
    ) return Promise.resolve({ ok: false, error: '文件快照校验请求无效' })
    return checkCheckpointFileCurrentMatch(runtimeRegistry.get(request.runtimeId), request.toolUseId, request.path)
  })
  ipcMain.handle(IPC.consensusStatus, () => {
    const reason = selectedRuntime().workspace.mode === 'ssh' ? 'SSH 工作区暂不支持协商模式' : checkConsensusReady()
    return { ready: reason === null, reason, enabled: selectedRuntime().consensusEnabled }
  })
  ipcMain.handle(IPC.listSessionSidebar, async (): Promise<SessionSidebarSnapshot> => {
    const currentSessionId = runtimeRegistry.selected?.sessionId ?? null
    const items = projectSessionListItems(
      (await sessions.list()).map(summary => ({ ...summary, title: sessionSidebarState.name(summary.sessionId) ?? summary.title })),
      runtimeRegistry.all(),
      currentSessionId,
      sessionSidebarState.orderedPinnedSessionIds(),
      (sessionId) => runtimeRegistry.hasUnreadCompletion(sessionId),
    )
    return { sessions: items, projects: projects.list() }
  })
  for (const [channel, mutate] of [
    [IPC.renameProject, (id: unknown, name: unknown) => projects.rename(id, name)],
    [IPC.removeProject, (id: unknown) => projects.remove(id)],
  ] as const) {
    ipcMain.handle(channel, async (event, id: unknown, name: unknown): Promise<WorkspaceActionResult> => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
        return { ok: false, error: '仅主页面可管理项目' }
      }
      try { await mutate(id, name); return { ok: true } }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    })
  }
  ipcMain.handle(IPC.newSession, (_e, request?: NewSessionRequest) =>
    startNewSession(request))
  ipcMain.handle(IPC.setSessionPinned, async (
    _e,
    request: SetSessionPinnedRequest,
  ): Promise<SetSessionPinnedResult> => {
    if (
      !request
      || typeof request.sessionId !== 'string'
      || typeof request.pinned !== 'boolean'
    ) return { ok: false, error: '置顶请求无效' }
    try {
      validateSessionId(request.sessionId)
      const exists = (await sessions.list())
        .some((summary) => summary.sessionId === request.sessionId)
      if (!exists) return { ok: false, error: '会话不存在' }
      await sessionSidebarState.setPinned(request.sessionId, request.pinned)
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
  ipcMain.handle(IPC.resumeSession, (_e, sessionId: string, historyStart?: string) => resumeSession(sessionId, historyStart))
  ipcMain.handle(IPC.renameSession, async (event, request: RenameSessionRequest): Promise<RenameSessionResult> => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, error: '仅主页面可重命名会话' }
    }
    try {
      if (!request || typeof request.sessionId !== 'string') throw new Error('重命名请求无效')
      validateSessionId(request.sessionId)
      const exists = (await sessions.list()).some(summary => summary.sessionId === request.sessionId)
      if (!exists || sessionDeletionLock.blocksSession(request.sessionId)) throw new Error('会话不存在或正在删除')
      await sessionSidebarState.setName(request.sessionId, request.name)
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle(IPC.forkSession, (_e, request: unknown) => forkSession(request))
  workspaceLifecycle = new WorkspaceLifecycle(managedWorkspaces, worktrees, async () => {
    const persisted = (await sessions.list()).flatMap(item => {
      const directory = item.workspace ? localWorkspaceDirectory(item.workspace) : null
      return directory ? [{ sessionId: item.sessionId as string | null, directory }] : []
    })
    const active = runtimeRegistry.all().flatMap(runtime => {
      const directory = localWorkspaceDirectory(runtime.workspace)
      return directory ? [{ sessionId: runtime.sessionId, directory }] : []
    })
    const draft = newSessionState.value
    const directory = draft ? localWorkspaceDirectory(draft.workspace) : null
    return [...persisted, ...active, ...(directory ? [{ sessionId: null, directory }] : [])]
  })
  registerWorkspaceLifecycleIpc(workspaceLifecycle, async sessionId => {
    const runtime = runtimeRegistry.findBySessionId(sessionId)
    if (runtime?.workspaceBinding) return runtime.workspaceBinding
    const summary = (await sessions.list()).find(item => item.sessionId === sessionId)
    if (!summary) throw new Error('会话不存在')
    return runtimeWorkspaceBinding(summary.workspace)
  })
  ipcMain.handle(IPC.deleteSession, (event, sessionId: string, options: DeleteSessionOptions) => {
    if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, error: '仅主页面可删除会话' }
    }
    return deleteSession(sessionId, options)
  })
  ipcMain.handle(IPC.worktreeStatus, (_e, runtimeId: string) =>
    currentWorktreeStatus(runtimeId))
  ipcMain.handle(IPC.createWorktreeBranch, (_e, runtimeId: string, branchName: string) =>
    createCurrentWorktreeBranch(runtimeId, branchName))
  ipcMain.handle(IPC.openWorkspaceFolder, (_e, runtimeId: string) =>
    openCurrentWorkspaceFolder(runtimeId))
  ipcMain.handle(IPC.discardWorktree, (_e, runtimeId: string) =>
    discardCurrentWorktree(runtimeId))
  ipcMain.handle(IPC.openPdfAttachment, async (
    _e,
    runtimeId: string,
    attachmentId: string,
  ) => {
    return openPdfAttachment(
      runtimeForId(runtimeId).journal,
      attachmentId,
      (path) => shell.openPath(path),
    )
  })
  ipcMain.handle(IPC.inspectDraftWorkspace, async (_event, runtimeId: string): Promise<WorkspaceActionResult<WorkspaceCandidate | null>> => {
    try {
      const runtime = runtimeForId(runtimeId)
      const directory = runtime.sessionId || runtime.workspace.mode === 'ssh' ? null : workspaceProjectDirectory(runtime.workspace)
      return { ok: true, value: directory ? await worktrees.inspect(directory) : null }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle(IPC.pickProjectDir, async (event, projectId?: string): Promise<WorkspaceActionResult<string | null>> => {
    if (sessionPreparationLock.sessionId || sessionNavigation.sessionId) {
      return { ok: false, error: '会话处理中，请稍后选择项目' }
    }
    const ownerWindow = BrowserWindow.fromWebContents(event.sender)
    if (!ownerWindow || ownerWindow.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, error: '仅主页面可选择项目' }
    }
    const selectionAtOpen = selectedRuntime()
    try {
      const selected = projectId === undefined
        ? (await dialog.showOpenDialog(ownerWindow, {
            title: '添加项目',
            defaultPath: sourceWorkspaceDirectory(selectionAtOpen.workspace),
            properties: ['openDirectory'],
          })).filePaths[0]
        : projects.get(projectId).directory
      if (!selected) return { ok: true, value: null }
      const directory = await canonicalDirectory(selected)
      // 父窗口模态约束用户交互；这里仍防御窗口销毁和其它宿主生命周期竞态。
      if (
        ownerWindow.isDestroyed()
        || runtimeRegistry.selected !== selectionAtOpen
        || sessionPreparationLock.sessionId
        || sessionNavigation.sessionId
      ) {
        return { ok: true, value: null }
      }
      if (projectId === undefined) await projects.add(directory)
      return { ok: true, value: directory }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  registerSshIpc(sshWorkspaces, projects)
  registerWorkspaceFileIpc(workspaceFiles, async runtimeId => {
    const runtime = runtimeForId(runtimeId)
    await sshWorkspaces.connect(runtime.workspace)
    const directory = workspaceDisplayDirectory(runtime.workspace)
    if (!directory) throw new Error('当前会话没有工作路径')
    return directory
  }, runtimeId => sshWorkspaces.io(runtimeForId(runtimeId).workspace))
  registerTerminalIpc(terminals, runtimeForId, prepareTerminalDirectory, runtime => runtime.workspace.mode === 'ssh'
    ? cwd => sshWorkspaces.terminal(runtime, cwd) : undefined)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

function requireDefaultWorkspace(): string {
  if (!defaultWorkspaceDir) throw new Error('默认工作文件夹尚未初始化')
  return defaultWorkspaceDir
}

function requireRuntimeProjectDir(runtime: DesktopSessionRuntime): string {
  const projectDir = runtime.projectDir
  if (!projectDir) throw new Error('当前会话没有可用的工作文件夹')
  return projectDir
}

async function prepareTerminalDirectory(runtime: DesktopSessionRuntime): Promise<string> {
  const reservation = runtime.routingGate.reserve()
  try {
    await reservation.ready
    if (runtime.isDisposed || shutdownStarted
      || (runtime.sessionId && sessionDeletionLock.sessionId === runtime.sessionId)) {
      throw new Error('当前会话正在关闭，无法打开终端')
    }
    await materializeWorkspace(runtime)
    return requireRuntimeProjectDir(runtime)
  } finally {
    reservation.release()
    runtime.notifyStateChanged()
    runtimeRegistry.runtimeBecameIdle(runtime)
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let shutdownStarted = false
// 所有窗口完成草稿落盘并关闭后，才释放运行时和事件通道。
app.on('will-quit', (event) => {
  terminals.closeOwner({})
  runtimeEventBatcher.flush()
  runtimeEventPorts.closeAll()
  if (shutdownStarted || !commandSessions) return
  event.preventDefault()
  shutdownStarted = true
  const closeWakeups = Promise.all([
    backgroundTaskWakeups?.close() ?? Promise.resolve(),
    subagentWakeups?.close() ?? Promise.resolve(),
  ])
  void closeWakeups
    .catch((error) => console.error('内部通知队列退出清理失败：', error))
    .then(() => Promise.all([
      subagents.close()
        .catch((error) => console.error('子代理退出清理失败：', error)),
      commandSessions.shutdown()
        .catch((error) => console.error('后台命令退出清理失败：', error)),
      runtimeRegistry.closeAll()
        .catch((error) => console.error('会话运行时退出清理失败：', error)),
      mcpOAuthController.close()
        .catch((error) => console.error('MCP OAuth 退出清理失败：', error)),
    ]))
    .finally(() => { sshWorkspaces?.connections.close(); app.quit() })
})
