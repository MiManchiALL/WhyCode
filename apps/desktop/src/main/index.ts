import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  AgentSession,
  cleanupUnreferencedAttachments,
  CommandSessionManager,
  ConsensusCoordinator,
  createBackgroundCommandTools,
  createAuxiliaryImageAnalyzer,
  createBuildOfficeArtifactTool,
  createInspectOfficeTool,
  createWebFetchTool,
  createWebFindTool,
  createWebSearchTool,
  ensureMcpConfigTemplate,
  ensureProjectMcpConfigTemplate,
  getModelEntry,
  installSystemSkills,
  loadMcpConfiguration,
  McpSessionRuntime,
  normalizeReasoningEffortSelection,
  type ConsensusAgentSetup,
  type CoreCommand,
  type CoreEvent,
  type ImageAttachment,
  type ImageDeliveryMode,
  type ManagedWorkspaceBinding,
  type ModelEntry,
  type PdfAttachment,
  type ProviderConfig,
  type ReasoningEffortSelection,
  type SessionJournal,
  SkillCatalogService,
  skillSummary,
  type ActivatedSkill,
  type WorkspaceBinding,
  type WorktreeWorkspaceBinding,
  workspaceWorkingDirectory,
} from '@whycode/core'
import type { PermissionMode } from '@whycode/core/permissions'
import { IPC } from '../shared/ipc.ts'
import { attachmentFallbackText } from '../shared/user-message.ts'
import {
  consensusAgentsReady,
  type ConfigSecretCodec,
  getConfigPath,
  loadConfig,
  migrateLegacyConfig,
  parseCliProxyModelId,
  resolveDefaultModelId,
  saveConfig,
  type WhycodeConfig,
} from './config.ts'
import {
  imageInputModeForModel,
  listModelConnections,
  pruneInvalidAuxiliaryModel,
  resolveAuxiliaryVisionModel,
  resolveModelConnection,
} from './model-connections.ts'
import {
  discoverCliProxyRoutes,
  unresolvedCliProxyProfiles,
} from './cli-proxy-discovery.ts'
import {
  createConnectionSettingsSnapshot,
  updateAuxiliaryModelSettings,
  updateCliProxyApiSettings,
  updateProviderSettings,
} from './model-settings.ts'
import {
  addMcpConfiguredServer,
  createMcpSettingsSnapshot,
  resolveMcpConfigPath,
  updateMcpSecretHeader,
  updateMcpServerState,
} from './mcp-settings.ts'
import { deleteSessionArtifacts } from './session-deletion.ts'
import { SessionDeletionLock } from './session-deletion-lock.ts'
import { DesktopSessionRepository } from './session-repository.ts'
import { SessionResumeLock } from './session-resume-lock.ts'
import {
  ensureCustomSystemPromptTemplate,
  getCustomSystemPromptConfigPath,
  loadCustomSystemPromptSnapshot,
} from './custom-system-prompt.ts'
import { retainReferencedRetiredModelLabels } from './retired-model-labels.ts'
import { routeUserMessage } from './user-message-routing.ts'
import { startEditedUserMessage } from './user-message-edit.ts'
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
  DeleteSessionResult,
  NewSessionRequest,
  NewSessionResult,
  ResumeSessionResult,
  RuntimeSnapshot,
  RuntimeEventEnvelope,
  RuntimeCommandEnvelope,
  RuntimeCommandResult,
  SessionListItem,
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
  prepareRuntimeWorkspace,
} from './runtime-workspace.ts'
import type {
  AddMcpServerRequest,
  ConnectionSettingsSnapshot,
  McpOAuthRequest,
  OpenMcpConfigRequest,
  SaveAuxiliaryModelSettingsRequest,
  SaveCliProxyApiSettingsRequest,
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
import { WorktreeManager } from './worktree-manager.ts'
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

const customSystemPromptConfigPath = getCustomSystemPromptConfigPath(getConfigPath())
const mcpGlobalConfigPath = join(dirname(getConfigPath()), 'mcp.json')

function loadAppConfig() {
  return loadConfig(getConfigPath(), configSecretCodec)
}

let permissionModeWriteTail: Promise<void> = Promise.resolve()

function persistPermissionMode(mode: PermissionMode): Promise<void> {
  // 多窗口快速切换必须按 IPC 到达顺序读改写配置，不能让较慢的旧选择最后覆盖新值。
  const write = permissionModeWriteTail.then(async () => {
    const config = loadAppConfig() ?? { providers: {} }
    await saveConfig({ ...config, permissionMode: mode }, configSecretCodec, getConfigPath())
  })
  permissionModeWriteTail = write.catch(() => {})
  return write
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

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

function broadcastRuntimeEvent(runtime: DesktopSessionRuntime, event: CoreEvent): void {
  const envelope: RuntimeEventEnvelope = {
    runtimeId: runtime.runtimeId,
    sessionId: runtime.sessionId,
    sequence: ++runtimeEventSequence,
    event,
  }
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.event, envelope)
  }
  if (
    event.type === 'agent-status'
    && (event.status === 'idle' || event.status === 'error')
  ) {
    runtimeRegistry.runtimeBecameIdle(runtime)
    void backgroundTaskWakeups?.nudge()
  }
}

/** 当前工作文件夹；app ready 后始终有值，启动默认目录与用户选择目录共享同一工具语义。 */
let defaultWorkspaceDir: string | null = null
/** Renderer 可以重载，权威运行态必须保留在不会随页面消失的主进程。 */
let runtimeEventSequence = 0
// --- 多 Agent 协商（M3）---
/** M4：JSONL 会话仓库；app ready 后用 userData/sessions 初始化 */
let sessions: DesktopSessionRepository
let runtimeRegistry!: SessionRuntimeRegistry
/** 后台命令跨 AgentSession 存活；任务仍按会话 ID 隔离。 */
let commandSessions: CommandSessionManager
/** detached 命令终态的内部通知队列；只负责调度，模型消息仍由 AgentSession 持久化。 */
let backgroundTaskWakeups: BackgroundTaskWakeQueue | null = null
/** WhyCode 受管 Git Worktree 的创建、所有权、恢复校验与清理事实源。 */
let worktrees: WorktreeManager
/** 每个默认会话独占一个受管子目录；外置 manifest 负责删除重试与所有权校验。 */
let managedWorkspaces: ManagedWorkspaceManager
/** Skill 解析缓存跨会话复用；每个根任务仍重新枚举并取得不可变快照。 */
let skills: SkillCatalogService
/** 删除跨多个存储始终单飞；历史删除不占用当前会话的运行时。 */
const sessionDeletionLock = new SessionDeletionLock()
/** 历史会话完整校验与候选运行时构造期间，只允许一个恢复事务。 */
const sessionResumeLock = new SessionResumeLock()
/** 连接设置写入期间阻止启动新 Agent 工作，避免配置在请求中途切换。 */
let settingsMutationInProgress = false
const pdfProcessor = new ElectronPdfProcessor()
const officeProcessor = new ElectronOfficeProcessor(pdfProcessor)
const officeArtifactRunner = new ElectronOfficeArtifactRunner()
const hostOperations = new HostOperationScheduler()

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

function managedWorkspaceBinding(
  workspace: RuntimeWorkspace | undefined,
): ManagedWorkspaceBinding | null {
  return workspace?.mode === 'managed' ? workspace : null
}

function sourceWorkspaceDirectory(workspace: RuntimeWorkspace): string {
  if (workspace.mode === 'pending-worktree') return workspace.selectedDirectory
  if (workspace.mode === 'pending-managed') return requireDefaultWorkspace()
  if (workspace.mode === 'worktree') {
    return workspace.relativeWorkingDirectory === '.'
      ? workspace.repositoryDirectory
      : join(
          workspace.repositoryDirectory,
          ...workspace.relativeWorkingDirectory.split('/'),
        )
  }
  return workspaceWorkingDirectory(workspace) ?? requireDefaultWorkspace()
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
    const path = requireRuntimeProjectDir(runtimeForId(runtimeId))
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
    if (runtime.sessionId) return deleteSession(runtime.sessionId)
    if (runtime.busy) throw new Error('Agent 工作中，请先停止再丢弃 Worktree')

    const wasSelected = runtimeRegistry.selected === runtime
    await runtimeRegistry.remove(runtime)
    detachedCurrent = wasSelected
    await worktrees.remove(binding, true)
    if (wasSelected) {
      replacementRuntime = createDefaultDraftRuntime()
      runtimeRegistry.select(replacementRuntime)
    }
    return {
      ok: true,
      deletedCurrent: wasSelected,
      ...(replacementRuntime
        ? { snapshot: await runtimeSnapshot(replacementRuntime) }
        : {}),
    }
  } catch (error) {
    if (detachedCurrent && !replacementRuntime) {
      replacementRuntime = createDefaultDraftRuntime()
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
  const runtime = new DesktopSessionRuntime({
    runtimeId,
    workspace,
    modelId: preferredModelId ?? resolveDefaultModelId(loadAppConfig()),
    permissionMode: preferredPermissionMode,
    emit: broadcastRuntimeEvent,
  })
  runtime.consensusEnabled = preferredConsensusEnabled
  runtimeRegistry.add(runtime)
  return runtime
}

function createDefaultDraftRuntime(runtimeId = randomUUID()): DesktopSessionRuntime {
  return createDraftRuntime(
    prepareDefaultRuntimeWorkspace(runtimeId, managedWorkspaces),
    runtimeId,
  )
}

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
function resolveCurrentModelId(runtime: DesktopSessionRuntime): string | null {
  runtime.modelId ??= preferredModelId ?? resolveDefaultModelId(loadAppConfig())
  return runtime.modelId
}

async function ensureSession(runtime: DesktopSessionRuntime): Promise<string | null> {
  const modelId = resolveCurrentModelId(runtime)
  if (!modelId) return '没有任何已配置 key 的模型可用'
  const err = validateModel(modelId)
  if (err) return err
  const resolved = resolveModelConnection(loadAppConfig(), modelId)
  if (!resolved.ok) return resolved.error
  const { entry, providerConfig } = resolved.value
  runtime.reasoningEffort = normalizeReasoningEffortSelection(
    entry.capabilities,
    runtime.reasoningEffort,
  )
  if (runtime.session) {
    await runtime.session.setModelSelection(entry, providerConfig, runtime.reasoningEffort)
  } else {
    if (!runtime.sessionInitialization) {
      let pending: Promise<string | null>
      pending = (async () => {
        const workspace = await materializeRuntimeWorkspace(
          runtime,
          worktrees,
          managedWorkspaces,
        )
        const recorder = runtime.journal ?? await createRuntimeJournal(
          runtime,
          workspace,
          modelId,
          runtime.reasoningEffort,
        )
        runtime.journal = recorder
        if (!runtime.session) {
          runtime.session = await createMainAgentSession(
            runtime,
            recorder,
            runtime.projectDir,
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
  runtime: DesktopSessionRuntime,
  workspace: WorkspaceBinding,
  modelId: string,
  reasoningEffort: ReasoningEffortSelection,
): Promise<SessionJournal> {
  const customSystemPrompt = await loadCustomSystemPromptSnapshot(
    customSystemPromptConfigPath,
  )
  const recorder = await sessions.create(
    workspace,
    modelId,
    reasoningEffort,
    customSystemPrompt,
  )
  try {
    if (workspace.mode === 'worktree') {
      await worktrees.attachSession(workspace, recorder.sessionId)
    } else if (workspace.mode === 'managed') {
      await managedWorkspaces.attachSession(workspace, recorder.sessionId)
    }
    return recorder
  } catch (error) {
    sessions.release(recorder)
    await sessions.markDeleting(recorder.sessionId).catch(() => false)
    await sessions.delete(recorder.sessionId).catch(() => false)
    throw error
  }
}

async function createMainAgentSession(
  runtime: DesktopSessionRuntime,
  recorder: SessionJournal,
  targetProjectDir: string | null,
  model: ModelEntry,
  providerConfig: ProviderConfig,
  reasoningEffort: ReasoningEffortSelection,
): Promise<AgentSession> {
  const mcpRuntime = new McpSessionRuntime({
    configuration: mcpOAuthController.runtimeConfiguration(
      await loadMcpConfiguration({
        globalConfigPath: mcpGlobalConfigPath,
        projectDir: targetProjectDir,
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
    const next = new AgentSession({
      model,
      providerConfig,
      reasoningEffort,
      promptContext: {
        projectDir: targetProjectDir,
        osPlatform: process.platform,
        homeDir: app.getPath('home'),
      },
      customSystemPrompt: recorder.customSystemPrompt,
      sessionRecorder: recorder,
      mcpRuntime,
      skillCatalog: skills,
      mainTools: [
        createBuildOfficeArtifactTool(officeArtifactRunner),
        createInspectOfficeTool(officeProcessor),
        ...createBackgroundCommandTools(commandSessions, recorder.sessionId),
        webSearchTool,
        ...createSessionWebPageTools(recorder),
      ],
      captureScreenshot: (request, abortSignal) =>
        hostOperations.runScreenshot(
          abortSignal,
          () => captureDesktopScreenshot(request, abortSignal),
        ),
      pdfProcessor,
      officeProcessor,
      auxiliaryImageAnalyzer: configuredAuxiliaryImageAnalyzer(),
      scheduleProjectMutation: (_mutation, abortSignal, operation) =>
        hostOperations.runProjectWrite(requireRuntimeProjectDir(runtime), abortSignal, operation),
      emit: (event) => runtime.emit(event),
      requestApproval: (request) => runtime.requestApproval(request),
    })
    next.setPermissionMode(runtime.permissionMode)
    return next
  } catch (error) {
    await mcpRuntime.close().catch(() => {})
    throw error
  }
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

function buildCoordinator(runtime: DesktopSessionRuntime): string | null {
  const journal = runtime.journal
  if (!journal) return '会话记录尚未初始化，无法启动协商'
  const result = createCoordinator(
    runtime,
    runtime.session!,
    journal,
    runtime.projectDir,
    journal.sessionId,
  )
  if (!result.ok) return result.error
  runtime.coordinator = result.value
  return null
}

function createCoordinator(
  runtime: DesktopSessionRuntime,
  mainSession: AgentSession,
  journal: SessionJournal,
  targetProjectDir: string | null,
  targetConversationId: string,
): { ok: true; value: ConsensusCoordinator } | { ok: false; error: string } {
  const notReady = checkConsensusReady()
  if (notReady) return { ok: false, error: notReady }
  const agents = loadAppConfig()!.consensusAgents!
  const setup = (id: 'B' | 'C'): ConsensusAgentSetup => ({
    model: getModelEntry(agents[id]!.model),
    providerConfig: { apiKey: agents[id]!.apiKey, baseURL: agents[id]!.baseURL },
  })
  const value = new ConsensusCoordinator({
    mainSession,
    projectDir: targetProjectDir,
    scratchRoot: join(app.getPath('userData'), 'scratch'),
    conversationId: targetConversationId,
    agents: { B: setup('B'), C: setup('C') },
    osPlatform: process.platform,
    homeDir: app.getPath('home'),
    emit: (event) => runtime.emit(event),
    requestApproval: (request) => runtime.requestApproval(request),
    initialState: journal.initialConsensusState,
    onTaskStart: (taskId, state, userText, deliveredInputIds) =>
      journal.recordConsensusTaskStart(taskId, state, userText, deliveredInputIds),
    onTaskEnd: (taskId, outcome, state) =>
      journal.recordConsensusTaskEnd(taskId, outcome, state),
    onInputsRestored: (inputIds) => journal.markUserInputsRestored(inputIds),
  })
  return { ok: true, value }
}

async function handleCommand(
  runtime: DesktopSessionRuntime,
  command: CoreCommand,
): Promise<RuntimeCommandResult | void> {
  if (
    sessionDeletionLock.blocksRuntime
    && sessionDeletionLock.sessionId === runtime.sessionId
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
    case 'edit-user-message':
      return handleEditUserMessageCommand(runtime, command)
    case 'abort': {
      // 中断时把所有挂起的审批一并拒绝，避免 run 永久卡在 await 上
      await runtime.abort()
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
      const notReady = checkConsensusReady()
      if (notReady) {
        runtime.emit({ type: 'error', message: notReady, recoverable: true })
        return { ok: false }
      }
      runtime.consensusEnabled = true
      preferredConsensusEnabled = true
      return { ok: true }
    }
    case 'set-permission-mode': {
      // 权限是当前运行时的执行边界，必须在任何磁盘等待之前生效；否则界面已显示只读时，
      // 旧审批仍可能在配置写入窗口内按原档位执行。持久化只负责下次会话偏好。
      runtime.setPermissionMode(command.mode)
      preferredPermissionMode = command.mode
      try {
        await persistPermissionMode(command.mode)
      } catch (error) {
        runtime.emit({
          type: 'error',
          message: `权限档位已在当前会话生效，但偏好保存失败；重启后可能恢复旧档位：${error instanceof Error ? error.message : String(error)}`,
          recoverable: true,
        })
      }
      return { ok: true }
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
      await runtime.session?.restoreCheckpoint(command.toolUseId, command.scope)
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
      if (!runtime.session) {
        runtime.emit({ type: 'error', message: '还没有对话，无需压缩', recoverable: true })
        break
      }
      await runtime.session.compactNow()
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
      const err = validateModel(command.modelId)
      if (err) {
        runtime.emit({ type: 'error', message: err, recoverable: true })
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
type EditUserMessageCommand = Extract<CoreCommand, { type: 'edit-user-message' }>
type PreparedUserMessage = PreparedUserMessageAttachments & { skills: ActivatedSkill[] }

async function handleEditUserMessageCommand(
  runtime: DesktopSessionRuntime,
  command: EditUserMessageCommand,
): Promise<{ ok: boolean }> {
  if (settingsMutationInProgress) {
    return { ok: false }
  }
  const reservation = runtimeRegistry.reserveWorkStart(runtime)
  if (!reservation) {
    return { ok: false }
  }
  synchronizeRuntimeAuxiliaryImageAnalyzer(runtime, loadAppConfig())
  const result = await startEditedUserMessage(
    runtime,
    reservation,
    command.turnId,
    command.text,
    (error) => reportUserMessageDeliveryError(runtime, error),
  )
  return { ok: result.ok }
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
    catalog: skills,
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
      prepared = await prepareUserMessage(runtime, command)
    } catch (error) {
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
    // 若后台终态正因 AskUserQuestion 等待真实回答，此时用户输入已优先完成路由，
    // 可在下一稳定步骤边界把通知交给同一 Agent，而不占用第二套轮询或计时器。
    void backgroundTaskWakeups?.nudge()
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
    (
      sessionDeletionLock.blocksRuntime
      && sessionDeletionLock.sessionId === runtime.sessionId
    )
    || runtime.busy,
  )
}

function runtimeExecutionBusy(runtime: DesktopSessionRuntime): boolean {
  return Boolean(
    (
      sessionDeletionLock.blocksRuntime
      && sessionDeletionLock.sessionId === runtime.sessionId
    )
    || runtime.executionBusy,
  )
}

function anyRuntimeBusy(): boolean {
  return settingsMutationInProgress || runtimeRegistry.anyBusy()
}

function resumeInProgressMessage(action: string): string {
  return `正在验证附件并恢复会话，请等待完成后再${action}`
}

function mcpOAuthInProgressMessage(action: string): string {
  return `MCP OAuth 登录进行中，请完成后再${action}`
}

async function persistConnectionConfig(
  config: NonNullable<ReturnType<typeof loadAppConfig>>,
): Promise<void> {
  config = pruneInvalidAuxiliaryModel(config)
  await saveConfig(config, configSecretCodec, getConfigPath())
  preferredModelId = preferredModelId
    && resolveModelConnection(config, preferredModelId).ok
    ? preferredModelId
    : resolveDefaultModelId(config)
  for (const runtime of runtimeRegistry.all()) {
    const current = runtime.modelId
      ? resolveModelConnection(config, runtime.modelId)
      : null
    // 退役/已删除连接的历史会话没有可构造的 Agent；保存设置不能替用户改写其模型事实。
    if (runtime.journal && !runtime.session && current && !current.ok) continue
    const targetModelId = current?.ok ? runtime.modelId : preferredModelId
    if (!runtime.session || !targetModelId) {
      runtime.modelId = targetModelId
      continue
    }
    const resolved = resolveModelConnection(config, targetModelId)
    if (!resolved.ok) continue
    const targetReasoningEffort = normalizeReasoningEffortSelection(
      resolved.value.entry.capabilities,
      runtime.reasoningEffort,
    )
    await runtime.session.setModelSelection(
      resolved.value.entry,
      resolved.value.providerConfig,
      targetReasoningEffort,
    )
    runtime.session.setAuxiliaryImageAnalyzer(configuredAuxiliaryImageAnalyzer(config))
    runtime.modelId = targetModelId
    runtime.reasoningEffort = targetReasoningEffort
  }
}

async function synchronizeConfiguredCliProxyRoutes(): Promise<void> {
  const loaded = loadAppConfig()
  if (!loaded) return
  const config = pruneInvalidAuxiliaryModel(loaded)
  if (config !== loaded) {
    await saveConfig(config, configSecretCodec, getConfigPath())
  }
  const connection = config.cliProxyApi
  if (!connection?.apiKey) return
  const modelRoutes = await discoverCliProxyRoutes(
    connection,
    (input, init) => net.fetch(input, init),
  )
  const modelIds = connection.modelIds.filter((modelId) => Boolean(modelRoutes[modelId]))
  if (
    sameStringRecord(connection.modelRoutes, modelRoutes)
    && sameStringArray(connection.modelIds, modelIds)
  ) return
  const next = structuredClone(config)
  next.cliProxyApi!.modelRoutes = modelRoutes
  next.cliProxyApi!.modelIds = modelIds
  const defaultCliProxyModelId = next.defaultModel
    ? parseCliProxyModelId(next.defaultModel)
    : null
  if (defaultCliProxyModelId && !modelIds.includes(defaultCliProxyModelId)) {
    delete next.defaultModel
  }
  await saveConfig(pruneInvalidAuxiliaryModel(next), configSecretCodec, getConfigPath())
}

async function pruneRetiredModelLabels(excludedSessionId?: string): Promise<void> {
  const referencedModelIds = new Set(
    (await sessions.list())
      .filter((summary) => summary.sessionId !== excludedSessionId)
      .map((summary) => summary.modelId)
      .filter((modelId): modelId is string => Boolean(modelId)),
  )
  const config = loadAppConfig()
  if (!config?.retiredModelLabels) return
  const next = retainReferencedRetiredModelLabels(config, referencedModelIds)
  if (next !== config) await saveConfig(next, configSecretCodec, getConfigPath())
}

function sameStringRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length
    && leftEntries.every(([key, value]) => right[key] === value)
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

async function saveProviderModelSettings(
  request: SaveProviderSettingsRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(async () => {
    const next = updateProviderSettings(loadAppConfig(), request)
    await persistConnectionConfig(next)
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
      const unresolved = unresolvedCliProxyProfiles(next.cliProxyApi.modelIds, modelRoutes)
      if (unresolved.length > 0) {
        const names = unresolved.map((modelId) => getModelEntry(modelId).displayName)
        throw new Error(`当前 CLIProxyAPI 实例没有公布以下等价路由：${names.join('、')}`)
      }
      next.cliProxyApi.modelRoutes = modelRoutes
    }
    await persistConnectionConfig(next)
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
      projectDir: selectedRuntime().projectDir,
    }, request))
}

async function addMcpConnection(
  request: AddMcpServerRequest,
): Promise<SettingsMutationResult> {
  return mutateConnectionSettings(() =>
    addMcpConfiguredServer({
      globalConfigPath: mcpGlobalConfigPath,
      projectDir: selectedRuntime().projectDir,
    }, request))
}

async function authorizeMcpOAuthConnection(
  request: McpOAuthRequest,
): Promise<SettingsMutationResult> {
  if (sessionDeletionLock.sessionId || sessionResumeLock.sessionId) {
    return {
      ok: false,
      error: sessionDeletionLock.sessionId
        ? '会话数据删除中，请等待完成后再开始 MCP OAuth 登录'
        : resumeInProgressMessage('开始 MCP OAuth 登录'),
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
        projectDir: selectedRuntime().projectDir,
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
    void backgroundTaskWakeups?.nudge()
  }
}

async function currentConnectionSettingsSnapshot(): Promise<ConnectionSettingsSnapshot> {
  const config = loadAppConfig()
  const runtime = selectedRuntime()
  const mcp = await createMcpSettingsSnapshot({
    globalConfigPath: mcpGlobalConfigPath,
    projectDir: runtime.projectDir,
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
    projectDir: selectedRuntime().projectDir,
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
        projectDir: selectedRuntime().projectDir,
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
): Promise<RuntimeSnapshot> {
  const journal = runtime.journal
  const timeline = journal
    ? await runtime.timeline.snapshotAt(journal, () => runtimeEventSequence)
    : { events: [], boundary: runtimeEventSequence }
  const busy = runtimeBusy(runtime)
  const checkpointRestoreToolUseId = runtime.checkpointRestoreToolUseId
  const deletingThisSession = Boolean(
    sessionDeletionLock.blocksRuntime
    && sessionDeletionLock.sessionId === runtime.sessionId,
  )
  return {
    runtimeId: runtime.runtimeId,
    workspace: runtime.workspace,
    modelId: resolveCurrentModelId(runtime),
    reasoningEffort: runtime.reasoningEffort,
    permissionMode: runtime.permissionMode,
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
    resumingSessionId: sessionResumeLock.sessionId,
    sessionId: journal?.sessionId ?? null,
    viewEvents: timeline.events,
    queuedInputs: journal ? pendingInputs(journal, 'queued') : [],
    restoredInputs: journal ? pendingInputs(journal, 'restored') : [],
    approval: runtime.approval,
    eventSequence: timeline.boundary,
  }
}

/**
 * 会话选择只有在对应快照也成功生成后才算提交。失败时恢复原选择；新构造的
 * 候选运行时同时从 Registry 与 Journal 内存索引释放，不能留下半切换状态。
 */
async function selectRuntimeWithSnapshot(
  runtime: DesktopSessionRuntime,
  removeOnFailure: boolean,
): Promise<RuntimeSnapshot> {
  const previous = runtimeRegistry.selected
  let snapshot: RuntimeSnapshot
  try {
    runtimeRegistry.select(runtime)
    snapshot = await runtimeSnapshot(runtime)
  } catch (error) {
    if (previous && previous !== runtime && !previous.isDisposed) {
      runtimeRegistry.select(previous)
    }
    if (removeOnFailure) {
      if (runtimeRegistry.get(runtime.runtimeId) === runtime) {
        await runtimeRegistry.remove(runtime)
      } else if (runtime.journal) {
        sessions.release(runtime.journal)
      }
    }
    throw error
  }
  if (previous && previous !== runtime) {
    await runtimeRegistry.removeUnselectedDraft(previous)
  }
  return snapshot
}

async function startNewSession(request?: NewSessionRequest): Promise<NewSessionResult> {
  if (sessionDeletionLock.sessionId || sessionResumeLock.sessionId) {
    return {
      ok: false,
      error: sessionDeletionLock.sessionId
        ? '会话数据删除中，请等待完成后再新建会话'
        : resumeInProgressMessage('新建会话'),
    }
  }
  try {
    const runtimeId = randomUUID()
    const workspace = request?.workspace
      ? await prepareRuntimeWorkspace(request.workspace, worktrees)
      : prepareDefaultRuntimeWorkspace(runtimeId, managedWorkspaces)
    const runtime = createDraftRuntime(workspace, runtimeId)
    return {
      ok: true,
      snapshot: await selectRuntimeWithSnapshot(runtime, true),
    }
  } catch (error) {
    return {
      ok: false,
      error: `新建会话失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function resumeSession(sessionId: string): Promise<ResumeSessionResult> {
  if (sessionDeletionLock.sessionId || sessionResumeLock.sessionId) {
    return {
      ok: false,
      error: sessionDeletionLock.sessionId
        ? '会话数据删除中，请等待完成后再恢复会话'
        : resumeInProgressMessage('恢复其它会话'),
    }
  }
  const existing = runtimeRegistry.findBySessionId(sessionId)
  if (existing) {
    try {
      const snapshot = await selectRuntimeWithSnapshot(existing, false)
      return { ok: true, snapshot }
    } catch (error) {
      return {
        ok: false,
        error: `会话恢复失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const release = sessionResumeLock.acquire(sessionId)
  if (!release) {
    return { ok: false, error: resumeInProgressMessage('恢复其它会话') }
  }
  let prepared: DesktopSessionRuntime | null = null
  try {
    prepared = await prepareResumedRuntime(sessionId)
    const snapshot = await selectRuntimeWithSnapshot(prepared, true)
    const resumedRuntime = prepared
    setTimeout(() => {
      if (!resumedRuntime.isDisposed) {
        resumedRuntime.emit({ type: 'agent-status', status: 'idle' }, false)
      }
    }, 0)
    return { ok: true, snapshot }
  } catch (error) {
    if (
      prepared
      && runtimeRegistry.get(prepared.runtimeId) === prepared
      && !prepared.isDisposed
    ) {
      await runtimeRegistry.remove(prepared).catch(() => {})
    }
    const message = `会话恢复失败：${error instanceof Error ? error.message : String(error)}`
    return { ok: false, error: message }
  } finally {
    release()
    void backgroundTaskWakeups?.nudge()
  }
}

async function prepareResumedRuntime(sessionId: string): Promise<DesktopSessionRuntime> {
  const journal = await sessions.prepareResume(sessionId)
  const metadata = journal.metadataSnapshot
  await journal.recoverInterruptedWork()
  const targetProjectDir = workspaceWorkingDirectory(metadata.workspace)
  const resolved = resolveModelConnection(loadAppConfig(), metadata.modelId)
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
  runtime.consensusEnabled = preferredConsensusEnabled
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
    if (resolved.ok) {
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
        journal.sessionId,
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

async function resolveBackgroundTaskRuntime(
  sessionId: string,
): Promise<BackgroundTaskRuntimeResolution> {
  if (sessionDeletionLock.sessionId === sessionId) return { kind: 'drop' }
  if (settingsMutationInProgress || sessionResumeLock.sessionId) return { kind: 'defer' }

  const existing = runtimeRegistry.findBySessionId(sessionId)
  if (existing) {
    if (!existing.session) {
      const error = await ensureSession(existing)
      if (error) return { kind: 'defer' }
    }
    return existing.session
      ? { kind: 'ready', runtime: existing }
      : { kind: 'defer' }
  }

  const summary = (await sessions.list()).find((item) => item.sessionId === sessionId)
  if (!summary || !summary.resumable) return { kind: 'drop' }
  const release = sessionResumeLock.acquire(sessionId)
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

async function deleteSession(sessionId: string): Promise<DeleteSessionResult> {
  const targetRuntime = runtimeRegistry.findBySessionId(sessionId)
  if (
    sessionDeletionLock.sessionId
    || sessionResumeLock.sessionId
    || mcpOAuthController.isAuthorizing()
    || targetRuntime?.busy
  ) {
    return {
      ok: false,
      error: sessionDeletionLock.sessionId
        ? '已有会话正在删除，请等待完成'
        : sessionResumeLock.sessionId
          ? resumeInProgressMessage('删除会话')
        : mcpOAuthController.isAuthorizing()
          ? mcpOAuthInProgressMessage('删除会话')
          : targetRuntime?.checkpointRestoreToolUseId
            ? '文件回滚中，请等待完成后再删除会话'
            : '目标会话仍在工作，请先停止再删除',
    }
  }
  const deletedCurrent = runtimeRegistry.selected?.sessionId === sessionId
  let detachedCurrent = false
  let replacementRuntime: DesktopSessionRuntime | null = null
  const releaseDeletion = sessionDeletionLock.acquire(sessionId, deletedCurrent)
  if (!releaseDeletion) return { ok: false, error: '已有会话正在删除，请等待完成' }
  try {
    const summary = targetRuntime
      ? null
      : (await sessions.list()).find((item) => item.sessionId === sessionId)
    const targetWorktree = worktreeBinding(
      targetRuntime?.workspace ?? summary?.workspace,
    )
    const targetManagedWorkspace = managedWorkspaceBinding(
      targetRuntime?.workspace ?? summary?.workspace,
    )
    const deleted = await deleteSessionArtifacts({
      sessionId,
      sessions,
      commandSessions,
      scratchRoot: join(app.getPath('userData'), 'scratch'),
      onDeletionMarked: async (sessionExists) => {
        if (!sessionExists) return
        backgroundTaskWakeups?.discardSession(sessionId)
        if (targetRuntime) await runtimeRegistry.remove(targetRuntime)
        if (deletedCurrent) {
          const replacement = createDefaultDraftRuntime()
          runtimeRegistry.select(replacement)
          replacementRuntime = replacement
          detachedCurrent = true
        }
      },
      onBeforeFactSourceDelete: async () => {
        if (targetWorktree) await worktrees.remove(targetWorktree, true)
        if (targetManagedWorkspace) {
          await managedWorkspaces.remove(targetManagedWorkspace)
        } else {
          await managedWorkspaces.removeSession(sessionId)
        }
        await pruneRetiredModelLabels(sessionId)
      },
    })
    if (!deleted) {
      return {
        ok: false,
        error: '会话不存在',
        deletedCurrent: detachedCurrent,
        ...(replacementRuntime
          ? { snapshot: await runtimeSnapshot(replacementRuntime) }
          : {}),
      }
    }
    return {
      ok: true,
      deletedCurrent,
      ...(replacementRuntime
        ? { snapshot: await runtimeSnapshot(replacementRuntime) }
        : {}),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      deletedCurrent: detachedCurrent || undefined,
      ...(replacementRuntime
        ? { snapshot: await runtimeSnapshot(replacementRuntime) }
        : {}),
    }
  } finally {
    releaseDeletion()
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
  preferredPermissionMode = loadAppConfig()?.permissionMode ?? 'default'
  await ensureCustomSystemPromptTemplate(customSystemPromptConfigPath)
    .catch((error) => console.warn('自定义 System 模板初始化失败：', error))
  await ensureMcpConfigTemplate(mcpGlobalConfigPath)
    .catch((error) => console.warn('MCP 配置模板初始化失败：', error))
  await installSystemSkills(app.getPath('home'))
    .catch((error) => console.warn('内置 Skill 初始化失败：', error))
  await synchronizeConfiguredCliProxyRoutes()
    .catch((error) => console.warn('CLIProxyAPI 模型目录同步失败：', error))
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
  skills = new SkillCatalogService({ homeDir: app.getPath('home') })
  worktrees = new WorktreeManager(join(dirname(getConfigPath()), 'worktrees'))
  managedWorkspaces = new ManagedWorkspaceManager(
    requireDefaultWorkspace(),
    join(dirname(getConfigPath()), 'managed-workspaces'),
  )
  await worktrees.pruneEmptyRepositoryDirectories()
    .catch((error) => console.warn('Worktree 空仓库目录清理失败：', error))
  try {
    const summaries = await sessions.list()
    const worktreeCleanup = await worktrees.cleanupAbandonedDrafts(
      new Set(summaries.flatMap((summary) =>
        summary.workspace?.mode === 'worktree' ? [summary.workspace.id] : [],
      )),
    )
    const managedCleanup = await managedWorkspaces.cleanupAbandoned(
      new Set(summaries.flatMap((summary) =>
        summary.workspace?.mode === 'managed' ? [summary.workspace.id] : [],
      )),
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
  } catch (error) {
    console.warn('受管工作区启动清理失败：', error)
  }
  runtimeRegistry = new SessionRuntimeRegistry({
    onDisposeError: (error) => console.error('会话运行时清理失败：', error),
    onRemoved: async (runtime) => {
      if (runtime.journal) sessions.release(runtime.journal)
      const workspace = runtime.workspaceBinding
      if (workspace?.mode === 'worktree' && runtime.journal) {
        worktrees.release(workspace, runtime.runtimeId)
      } else if (workspace?.mode === 'worktree') {
        await worktrees.cleanupDraft(workspace, runtime.runtimeId)
      } else if (workspace?.mode === 'managed' && !runtime.journal) {
        await managedWorkspaces.remove(workspace)
      }
    },
  })
  const initialRuntime = createDefaultDraftRuntime()
  runtimeRegistry.select(initialRuntime)
  await pruneRetiredModelLabels()
    .catch((error) => console.warn('退役模型显示名清理失败：', error))
  registerAttachmentProtocol((sessionId) =>
    runtimeRegistry.findBySessionId(sessionId)?.journal ?? null)
  backgroundTaskWakeups = new BackgroundTaskWakeQueue({
    resolveRuntime: resolveBackgroundTaskRuntime,
    reserveWorkStart: (runtime) => runtimeRegistry.reserveWorkStart(runtime),
    deliveryBlocked: (runtime) => Boolean(
      runtime.isDisposed
      || !runtime.session
      || runtime.session.waitingForUserInput
      || runtime.coordinator?.busy
      || (
        sessionDeletionLock.blocksRuntime
        && sessionDeletionLock.sessionId === runtime.sessionId
      ),
    ),
    deliver: deliverBackgroundTaskNotification,
    onError: (error) => console.error('后台任务完成通知调度失败：', error),
  })
  commandSessions = new CommandSessionManager(
    join(app.getPath('userData'), 'command-tasks'),
    {
      onDetachedTaskTerminal: (notification) =>
        backgroundTaskWakeups?.enqueue(notification),
    },
  )
  await commandSessions.initialize()
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
  ipcMain.handle(IPC.listModels, (_e, runtimeId?: string) => {
    const runtime = runtimeForId(runtimeId)
    return listModelConnections(loadAppConfig(), resolveCurrentModelId(runtime))
  })
  ipcMain.handle(IPC.listSkills, async (_e, runtimeId?: string) => {
    const runtime = runtimeForId(runtimeId)
    const modelId = resolveCurrentModelId(runtime)
    const resolved = modelId
      ? resolveModelConnection(loadAppConfig(), modelId)
      : null
    const contextWindow = resolved?.ok
      ? resolved.value.entry.capabilities.contextWindow
      : undefined
    // pending-worktree 尚未创建真实目录；此时目录只展示用户级与内置 Skill，避免签发
    // 指向源仓库、却要在首条消息创建后的 Worktree 中校验的失效 locator。
    return skills.list(runtime.projectDir, contextWindow)
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
  ipcMain.handle(IPC.runtimeSnapshot, (_e, runtimeId?: string) =>
    runtimeSnapshot(runtimeForId(runtimeId)))
  ipcMain.handle(IPC.consensusStatus, () => ({
    ready: checkConsensusReady() === null,
    reason: checkConsensusReady(),
    enabled: selectedRuntime().consensusEnabled,
  }))
  ipcMain.handle(IPC.listSessions, async (): Promise<SessionListItem[]> => {
    const currentSessionId = runtimeRegistry.selected?.sessionId ?? null
    return (await sessions.list()).map((item) => ({
      ...item,
      isCurrent: item.sessionId === currentSessionId,
      runtimeStatus: runtimeRegistry.findBySessionId(item.sessionId)?.status,
      running: runtimeRegistry.findBySessionId(item.sessionId)?.busy ?? false,
      needsAttention: Boolean(
        runtimeRegistry.findBySessionId(item.sessionId)?.approval
        || item.status === 'waiting-user',
      ),
    }))
  })
  ipcMain.handle(IPC.newSession, (_e, request?: NewSessionRequest) =>
    startNewSession(request))
  ipcMain.handle(IPC.resumeSession, (_e, sessionId: string) => resumeSession(sessionId))
  ipcMain.handle(IPC.deleteSession, (_e, sessionId: string) => deleteSession(sessionId))
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
  ipcMain.handle(IPC.pickProjectDir, async (): Promise<WorkspaceCandidate | null> => {
    if (sessionDeletionLock.sessionId || sessionResumeLock.sessionId) {
      return null
    }
    const selectionAtOpen = selectedRuntime()
    const result = await dialog.showOpenDialog({
      title: '选择工作文件夹',
      defaultPath: sourceWorkspaceDirectory(selectionAtOpen.workspace),
      properties: ['openDirectory'],
    })
    const selected = result.filePaths[0]
    if (!selected) return null
    try {
      const candidate = await worktrees.inspect(selected)
      // 原生对话框期间允许其它入口切换会话；旧选择不能覆盖后来发生的用户操作。
      if (
        runtimeRegistry.selected !== selectionAtOpen
        || sessionDeletionLock.sessionId
        || sessionResumeLock.sessionId
      ) {
        return null
      }
      return candidate
    } catch (error) {
      selectionAtOpen.emit({
        type: 'error',
        message: `工作文件夹检查失败：${
          error instanceof Error ? error.message : String(error)
        }`,
        recoverable: true,
      })
      return null
    }
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

function requireRuntimeProjectDir(runtime: DesktopSessionRuntime): string {
  const projectDir = runtime.projectDir
  if (!projectDir) throw new Error('当前会话没有可用的工作文件夹')
  return projectDir
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let shutdownStarted = false
app.on('before-quit', (event) => {
  if (shutdownStarted || !commandSessions) return
  event.preventDefault()
  shutdownStarted = true
  const closeBackgroundTaskWakeups = backgroundTaskWakeups
    ? backgroundTaskWakeups.close()
    : Promise.resolve()
  void closeBackgroundTaskWakeups
    .catch((error) => console.error('后台任务通知队列退出清理失败：', error))
    .then(() => Promise.all([
      commandSessions.shutdown()
        .catch((error) => console.error('后台命令退出清理失败：', error)),
      runtimeRegistry.closeAll()
        .catch((error) => console.error('会话运行时退出清理失败：', error)),
      mcpOAuthController.close()
        .catch((error) => console.error('MCP OAuth 退出清理失败：', error)),
    ]))
    .finally(() => app.quit())
})
