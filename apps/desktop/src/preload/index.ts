import { contextBridge, ipcRenderer } from 'electron'
import type { CoreCommand, CoreEvent } from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
import type {
  DeleteSessionResult,
  ResumeSessionResult,
  RuntimeSnapshot,
  RuntimeEventEnvelope,
  SessionActionResult,
  SessionListItem,
} from '../shared/session.ts'

/** 暴露给 Renderer 的类型安全 API（window.whycode） */
const api = {
  sendCommand: (command: CoreCommand): Promise<{ ok: boolean } | void> =>
    ipcRenderer.invoke(IPC.command, command),
  listModels: (): Promise<{ id: string; displayName: string; hasKey: boolean }[]> =>
    ipcRenderer.invoke(IPC.listModels),
  getProjectDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.getProjectDir),
  runtimeSnapshot: (): Promise<RuntimeSnapshot> => ipcRenderer.invoke(IPC.runtimeSnapshot),
  pickProjectDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickProjectDir),
  consensusStatus: (): Promise<{ ready: boolean; reason: string | null; enabled: boolean }> =>
    ipcRenderer.invoke(IPC.consensusStatus),
  listSessions: (): Promise<SessionListItem[]> => ipcRenderer.invoke(IPC.listSessions),
  resumeSession: (sessionId: string): Promise<ResumeSessionResult> =>
    ipcRenderer.invoke(IPC.resumeSession, sessionId),
  newSession: (): Promise<SessionActionResult> => ipcRenderer.invoke(IPC.newSession),
  deleteSession: (sessionId: string): Promise<DeleteSessionResult> =>
    ipcRenderer.invoke(IPC.deleteSession, sessionId),
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
