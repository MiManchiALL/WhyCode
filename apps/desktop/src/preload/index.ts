import type { RetainedWorkspaceList, RetainedWorkspaceTarget, WorkspaceDeletionPreview } from '../shared/workspace-lifecycle.ts'
import {
  contextBridge,
  ipcRenderer,
  webUtils,
  type IpcRendererEvent,
} from 'electron'
import type {
  BackgroundTaskState,
  CoreCommand,
  SkillCatalogSnapshot,
  SubagentEventEnvelope,
  SubagentState,
  SubagentTranscriptSnapshot,
} from '@whycode/core'
import type { ConversationHistoryRequest, ConversationHistoryResult } from '../shared/conversation-history.ts'
import { IPC } from '../shared/ipc.ts'
import type { OpenWorkspaceFileRequest, ReadWorkspaceFileRequest, WorkspaceFileChange, WorkspaceFileResult } from '../shared/workspace-files.ts'
import type { TerminalControl, TerminalEvent, TerminalInfo } from '../shared/terminal.ts'
import type {
  CheckpointFileChangesRequest,
  CheckpointFileChangesResult,
  CheckpointFileCurrentMatchRequest,
  CheckpointFileCurrentMatchResult,
  CheckpointFilePreviewRequest,
  CheckpointFilePreviewResult,
  DeleteSessionResult,
  ForkSessionRequest,
  ForkSessionResult,
  NewSessionRequest,
  NewSessionResult,
  ResumeSessionResult,
  RuntimeSnapshot,
  RuntimeCommandEnvelope,
  RuntimeCommandResult,
  SessionDeletionState,
  SessionListItem,
  SetSessionPinnedRequest,
  SetSessionPinnedResult,
} from '../shared/session.ts'
import type {
  WorkspaceActionResult,
  WorkspaceCandidate,
  WorktreeStatus,
} from '../shared/workspace.ts'
import type {
  AddMcpServerRequest,
  ConnectionSettingsSnapshot,
  McpConnectionStatus,
  McpOAuthRequest,
  ModelListItem,
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
  RUNTIME_EVENT_PORT_READY_MESSAGE,
  RUNTIME_EVENT_PORT_REQUEST_MESSAGE,
} from '../shared/runtime-event-port.ts'

type PreloadMessagePort = IpcRendererEvent['ports'][number]

interface PreloadWindowMessageEvent {
  source: unknown
  data: unknown
}

interface PreloadWindow {
  addEventListener: (
    type: 'message',
    listener: (event: PreloadWindowMessageEvent) => void,
  ) => void
  postMessage: (
    message: string,
    targetOrigin: string,
    transfer?: PreloadMessagePort[],
  ) => void
}

const preloadWindow = globalThis as unknown as PreloadWindow
let pendingRuntimeEventPort: PreloadMessagePort | null = null
let rendererWaitingForRuntimeEventPort = false
let runtimeEventPortRequestInFlight = false

function deliverRuntimeEventPort(): void {
  if (!rendererWaitingForRuntimeEventPort || !pendingRuntimeEventPort) return
  const port = pendingRuntimeEventPort
  pendingRuntimeEventPort = null
  rendererWaitingForRuntimeEventPort = false
  preloadWindow.postMessage(RUNTIME_EVENT_PORT_READY_MESSAGE, '*', [port])
}

ipcRenderer.on(IPC.runtimeEventPort, (event) => {
  runtimeEventPortRequestInFlight = false
  const port = event.ports[0]
  if (!port) return
  pendingRuntimeEventPort?.close()
  pendingRuntimeEventPort = port
  deliverRuntimeEventPort()
})

preloadWindow.addEventListener('message', (event) => {
  if (
    event.source !== globalThis
    || event.data !== RUNTIME_EVENT_PORT_REQUEST_MESSAGE
  ) return
  rendererWaitingForRuntimeEventPort = true
  if (pendingRuntimeEventPort) {
    deliverRuntimeEventPort()
    return
  }
  if (runtimeEventPortRequestInFlight) return
  runtimeEventPortRequestInFlight = true
  ipcRenderer.send(IPC.runtimeEventPortRequest)
})

/** 暴露给 Renderer 的类型安全 API（window.whycode） */
const api = {
  onBeforeClose: (save: () => Promise<void>): (() => void) => {
    const listener = (_: unknown, state: unknown) => {
      if (state !== 'flush') return
      void Promise.resolve().then(save).then(
        () => ipcRenderer.send(IPC.composerPersistence, 'saved'),
        () => ipcRenderer.send(IPC.composerPersistence, 'failed'),
      )
    }
    ipcRenderer.on(IPC.composerPersistence, listener)
    ipcRenderer.send(IPC.composerPersistence, 'ready')
    return () => {
      ipcRenderer.off(IPC.composerPersistence, listener)
      ipcRenderer.send(IPC.composerPersistence, 'unready')
    }
  },
  createTerminal: (runtimeId: string): Promise<TerminalInfo> =>
    ipcRenderer.invoke(IPC.createTerminal, runtimeId),
  closeTerminal: (terminalId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.closeTerminal, terminalId),
  controlTerminal: (control: TerminalControl): void =>
    ipcRenderer.send(IPC.terminalControl, control),
  onTerminalEvent: (listener: (event: TerminalEvent) => void): (() => void) => {
    const wrapped = (_: unknown, event: TerminalEvent) => listener(event)
    ipcRenderer.on(IPC.terminalEvent, wrapped)
    return () => ipcRenderer.off(IPC.terminalEvent, wrapped)
  },
  onTerminalClosed: (listener: (terminalId: string) => void): (() => void) => {
    const wrapped = (_: unknown, terminalId: string) => listener(terminalId)
    ipcRenderer.on(IPC.terminalClosed, wrapped)
    return () => ipcRenderer.off(IPC.terminalClosed, wrapped)
  },
  sendCommand: (
    runtimeId: string,
    command: CoreCommand,
  ): Promise<RuntimeCommandResult | void> =>
    ipcRenderer.invoke(IPC.command, {
      runtimeId,
      command,
    } satisfies RuntimeCommandEnvelope),
  listModels: (runtimeId?: string): Promise<ModelListItem[]> =>
    ipcRenderer.invoke(IPC.listModels, runtimeId),
  listSkills: (runtimeId?: string): Promise<SkillCatalogSnapshot> =>
    ipcRenderer.invoke(IPC.listSkills, runtimeId),
  mcpStatus: (runtimeId: string): Promise<McpConnectionStatus[]> =>
    ipcRenderer.invoke(IPC.mcpStatus, runtimeId),
  connectionSettings: (): Promise<ConnectionSettingsSnapshot> =>
    ipcRenderer.invoke(IPC.connectionSettings),
  saveProviderSettings: (
    request: SaveProviderSettingsRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.saveProviderSettings, request),
  saveCliProxyApiSettings: (
    request: SaveCliProxyApiSettingsRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.saveCliProxyApiSettings, request),
  saveAuxiliaryModelSettings: (
    request: SaveAuxiliaryModelSettingsRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(
    IPC.saveAuxiliaryModelSettings,
    request,
  ),
  saveConsensusModelSettings: (
    request: SaveConsensusModelSettingsRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(
    IPC.saveConsensusModelSettings,
    request,
  ),
  saveWebSearchSettings: (
    request: SaveWebSearchSettingsRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.saveWebSearchSettings, request),
  setMcpServerEnabled: (
    request: SetMcpServerEnabledRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.setMcpServerEnabled, request),
  addMcpServer: (
    request: AddMcpServerRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.addMcpServer, request),
  saveMcpSecretHeader: (
    request: SaveMcpSecretHeaderRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.saveMcpSecretHeader, request),
  authorizeMcpOAuth: (
    request: McpOAuthRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.authorizeMcpOAuth, request),
  disconnectMcpOAuth: (
    request: McpOAuthRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.disconnectMcpOAuth, request),
  openMcpConfig: (
    request: OpenMcpConfigRequest,
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.openMcpConfig, request),
  /** sandbox Renderer 不能读取 File.path；只通过 Electron 官方桥接取得本地选择路径。 */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  conversationHistory: (request: ConversationHistoryRequest): Promise<ConversationHistoryResult> =>
    ipcRenderer.invoke(IPC.conversationHistory, request),
  runtimeSnapshot: (runtimeId?: string): Promise<RuntimeSnapshot> =>
    ipcRenderer.invoke(IPC.runtimeSnapshot, runtimeId),
  subagentTranscript: (
    parentSessionId: string,
    subagentId: string,
  ): Promise<SubagentTranscriptSnapshot> =>
    ipcRenderer.invoke(IPC.subagentTranscript, parentSessionId, subagentId),
  checkpointFileChanges: (request: CheckpointFileChangesRequest): Promise<CheckpointFileChangesResult> =>
    ipcRenderer.invoke(IPC.checkpointFileChanges, request),
  checkpointFilePreview: (
    request: CheckpointFilePreviewRequest,
  ): Promise<CheckpointFilePreviewResult> =>
    ipcRenderer.invoke(IPC.checkpointFilePreview, request),
  checkpointFileCurrentMatch: (
    request: CheckpointFileCurrentMatchRequest,
  ): Promise<CheckpointFileCurrentMatchResult> =>
    ipcRenderer.invoke(IPC.checkpointFileCurrentMatch, request),
  openWorkspaceFile: (request: OpenWorkspaceFileRequest): Promise<WorkspaceFileResult> =>
    ipcRenderer.invoke(IPC.openWorkspaceFile, request),
  readWorkspaceFile: (request: ReadWorkspaceFileRequest): Promise<WorkspaceFileResult> =>
    ipcRenderer.invoke(IPC.readWorkspaceFile, request),
  closeWorkspaceFile: (id: string): void => ipcRenderer.send(IPC.closeWorkspaceFile, id),
  revealWorkspaceFile: (id: string): Promise<void> => ipcRenderer.invoke(IPC.revealWorkspaceFile, id),
  openWorkspaceFileExternally: (id: string): Promise<void> => ipcRenderer.invoke(IPC.openWorkspaceFileExternally, id),
  onWorkspaceFileChanged: (callback: (change: WorkspaceFileChange) => void): (() => void) => {
    const listener = (_event: IpcRendererEvent, change: WorkspaceFileChange) => callback(change)
    ipcRenderer.on(IPC.workspaceFileChanged, listener)
    return () => ipcRenderer.removeListener(IPC.workspaceFileChanged, listener)
  },
  pickProjectDir: (): Promise<WorkspaceCandidate | null> =>
    ipcRenderer.invoke(IPC.pickProjectDir),
  worktreeStatus: (
    runtimeId: string,
  ): Promise<WorkspaceActionResult<WorktreeStatus>> =>
    ipcRenderer.invoke(IPC.worktreeStatus, runtimeId),
  createWorktreeBranch: (
    runtimeId: string,
    branchName: string,
  ): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.createWorktreeBranch, runtimeId, branchName),
  openWorkspaceFolder: (runtimeId: string): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.openWorkspaceFolder, runtimeId),
  discardWorktree: (runtimeId: string): Promise<DeleteSessionResult> =>
    ipcRenderer.invoke(IPC.discardWorktree, runtimeId),
  consensusStatus: (): Promise<{ ready: boolean; reason: string | null; enabled: boolean }> =>
    ipcRenderer.invoke(IPC.consensusStatus),
  listSessions: (): Promise<SessionListItem[]> => ipcRenderer.invoke(IPC.listSessions),
  resumeSession: (sessionId: string, historyStart?: string): Promise<ResumeSessionResult> =>
    ipcRenderer.invoke(IPC.resumeSession, sessionId, historyStart),
  forkSession: (request: ForkSessionRequest): Promise<ForkSessionResult> =>
    ipcRenderer.invoke(IPC.forkSession, request),
  newSession: (request?: NewSessionRequest): Promise<NewSessionResult> =>
    ipcRenderer.invoke(IPC.newSession, request),
  setSessionPinned: (request: SetSessionPinnedRequest): Promise<SetSessionPinnedResult> =>
    ipcRenderer.invoke(IPC.setSessionPinned, request),
  deleteSession: (sessionId: string, deleteDirectory: boolean): Promise<DeleteSessionResult> =>
    ipcRenderer.invoke(IPC.deleteSession, sessionId, deleteDirectory),
  previewSessionDeletion: (sessionId: string): Promise<WorkspaceActionResult<WorkspaceDeletionPreview>> =>
    ipcRenderer.invoke(IPC.previewSessionDeletion, sessionId),
  listRetainedWorkspaces: (): Promise<WorkspaceActionResult<RetainedWorkspaceList>> =>
    ipcRenderer.invoke(IPC.listRetainedWorkspaces),
  previewRetainedWorkspace: (target: RetainedWorkspaceTarget): Promise<WorkspaceActionResult<WorkspaceDeletionPreview>> =>
    ipcRenderer.invoke(IPC.previewRetainedWorkspace, target),
  openRetainedWorkspace: (target: RetainedWorkspaceTarget): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.openRetainedWorkspace, target),
  renameRetainedWorkspace: (target: RetainedWorkspaceTarget, name: string): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.renameRetainedWorkspace, target, name),
  deleteRetainedWorkspace: (target: RetainedWorkspaceTarget): Promise<WorkspaceActionResult> =>
    ipcRenderer.invoke(IPC.deleteRetainedWorkspace, target),
  openPdfAttachment: (
    runtimeId: string,
    attachmentId: string,
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.openPdfAttachment, runtimeId, attachmentId),
  onBackgroundTasks: (
    listener: (state: BackgroundTaskState) => void,
  ): (() => void) => {
    const wrapped = (_: unknown, state: BackgroundTaskState) => listener(state)
    ipcRenderer.on(IPC.backgroundTasks, wrapped)
    return () => ipcRenderer.off(IPC.backgroundTasks, wrapped)
  },
  onSessionDeletion: (
    listener: (state: SessionDeletionState) => void,
  ): (() => void) => {
    const wrapped = (_: unknown, state: SessionDeletionState) => listener(state)
    ipcRenderer.on(IPC.sessionDeletion, wrapped)
    return () => ipcRenderer.off(IPC.sessionDeletion, wrapped)
  },
  onSubagents: (
    listener: (state: SubagentState) => void,
  ): (() => void) => {
    const wrapped = (_: unknown, state: SubagentState) => listener(state)
    ipcRenderer.on(IPC.subagents, wrapped)
    return () => ipcRenderer.off(IPC.subagents, wrapped)
  },
  onSubagentEvent: (
    listener: (event: SubagentEventEnvelope) => void,
  ): (() => void) => {
    const wrapped = (_: unknown, event: SubagentEventEnvelope) => listener(event)
    ipcRenderer.on(IPC.subagentEvent, wrapped)
    return () => ipcRenderer.off(IPC.subagentEvent, wrapped)
  },
}

export type WhycodeApi = typeof api

contextBridge.exposeInMainWorld('whycode', api)
