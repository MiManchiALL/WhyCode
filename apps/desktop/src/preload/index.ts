import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  BackgroundTaskState,
  CoreCommand,
  CoreEvent,
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
  RuntimeEventEnvelope,
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
  onEvent: (
    listener: (
      event: CoreEvent,
      sequence: number,
      runtimeId: string,
      sessionId: string | null,
      occurredAt: string,
    ) => void,
  ): (() => void) => {
    const wrapped = (_: unknown, envelope: RuntimeEventEnvelope) => {
      listener(
        envelope.event,
        envelope.sequence,
        envelope.runtimeId,
        envelope.sessionId,
        envelope.occurredAt,
      )
    }
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.off(IPC.event, wrapped)
  },
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
