import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CoreCommand, CoreEvent, SkillCatalogSnapshot } from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
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
  SaveCliProxyApiSettingsRequest,
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
  pickProjectDir: (): Promise<WorkspaceCandidate | null> =>
    ipcRenderer.invoke(IPC.pickProjectDir),
  inspectCurrentWorkspace: (runtimeId?: string): Promise<WorkspaceCandidate> =>
    ipcRenderer.invoke(IPC.inspectCurrentWorkspace, runtimeId),
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
  newSession: (request: NewSessionRequest): Promise<NewSessionResult> =>
    ipcRenderer.invoke(IPC.newSession, request),
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
    ) => void,
  ): (() => void) => {
    const wrapped = (_: unknown, envelope: RuntimeEventEnvelope) => {
      listener(
        envelope.event,
        envelope.sequence,
        envelope.runtimeId,
        envelope.sessionId,
      )
    }
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.off(IPC.event, wrapped)
  },
}

export type WhycodeApi = typeof api

contextBridge.exposeInMainWorld('whycode', api)
