import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { CoreCommand, CoreEvent } from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
import type {
  DeleteSessionResult,
  NewSessionResult,
  ResumeSessionResult,
  RuntimeSnapshot,
  RuntimeEventEnvelope,
  SessionListItem,
} from '../shared/session.ts'
import type {
  ConnectionSettingsSnapshot,
  EnableMcpPresetRequest,
  ModelListItem,
  OpenMcpConfigRequest,
  SaveCliProxyApiSettingsRequest,
  SaveProviderSettingsRequest,
  SaveWebSearchSettingsRequest,
  SetMcpServerEnabledRequest,
  SettingsMutationResult,
} from '../shared/settings.ts'

/** 暴露给 Renderer 的类型安全 API（window.whycode） */
const api = {
  sendCommand: (command: CoreCommand): Promise<{ ok: boolean } | void> =>
    ipcRenderer.invoke(IPC.command, command),
  listModels: (): Promise<ModelListItem[]> => ipcRenderer.invoke(IPC.listModels),
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
  enableMcpPreset: (
    request: EnableMcpPresetRequest,
  ): Promise<SettingsMutationResult> => ipcRenderer.invoke(IPC.enableMcpPreset, request),
  openMcpConfig: (
    request: OpenMcpConfigRequest,
  ): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.openMcpConfig, request),
  /** sandbox Renderer 不能读取 File.path；只通过 Electron 官方桥接取得本地选择路径。 */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  getProjectDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.getProjectDir),
  runtimeSnapshot: (): Promise<RuntimeSnapshot> => ipcRenderer.invoke(IPC.runtimeSnapshot),
  pickProjectDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickProjectDir),
  consensusStatus: (): Promise<{ ready: boolean; reason: string | null; enabled: boolean }> =>
    ipcRenderer.invoke(IPC.consensusStatus),
  listSessions: (): Promise<SessionListItem[]> => ipcRenderer.invoke(IPC.listSessions),
  resumeSession: (sessionId: string): Promise<ResumeSessionResult> =>
    ipcRenderer.invoke(IPC.resumeSession, sessionId),
  newSession: (): Promise<NewSessionResult> => ipcRenderer.invoke(IPC.newSession),
  deleteSession: (sessionId: string): Promise<DeleteSessionResult> =>
    ipcRenderer.invoke(IPC.deleteSession, sessionId),
  openPdfAttachment: (attachmentId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke(IPC.openPdfAttachment, attachmentId),
  onEvent: (listener: (event: CoreEvent, sequence: number) => void): (() => void) => {
    const wrapped = (_: unknown, envelope: RuntimeEventEnvelope) => {
      listener(envelope.event, envelope.sequence)
    }
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.off(IPC.event, wrapped)
  },
}

export type WhycodeApi = typeof api

contextBridge.exposeInMainWorld('whycode', api)
