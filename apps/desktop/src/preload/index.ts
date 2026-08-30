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
import { IPC } from '../shared/ipc.ts'
import type {
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
  runtimeSnapshot: (runtimeId?: string): Promise<RuntimeSnapshot> =>
    ipcRenderer.invoke(IPC.runtimeSnapshot, runtimeId),
  subagentTranscript: (
    parentSessionId: string,
    subagentId: string,
  ): Promise<SubagentTranscriptSnapshot> =>
    ipcRenderer.invoke(IPC.subagentTranscript, parentSessionId, subagentId),
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
  resumeSession: (sessionId: string): Promise<ResumeSessionResult> =>
    ipcRenderer.invoke(IPC.resumeSession, sessionId),
  forkSession: (request: ForkSessionRequest): Promise<ForkSessionResult> =>
    ipcRenderer.invoke(IPC.forkSession, request),
  newSession: (request?: NewSessionRequest): Promise<NewSessionResult> =>
    ipcRenderer.invoke(IPC.newSession, request),
  setSessionPinned: (request: SetSessionPinnedRequest): Promise<SetSessionPinnedResult> =>
    ipcRenderer.invoke(IPC.setSessionPinned, request),
  deleteSession: (sessionId: string): Promise<DeleteSessionResult> =>
    ipcRenderer.invoke(IPC.deleteSession, sessionId),
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
