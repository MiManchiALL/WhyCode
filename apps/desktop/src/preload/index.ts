import { contextBridge, ipcRenderer } from 'electron'
import type { CoreCommand, CoreEvent } from '@whycode/core'
import { IPC } from '../shared/ipc.ts'

/** 暴露给 Renderer 的类型安全 API（window.whycode） */
const api = {
  sendCommand: (command: CoreCommand): Promise<{ ok: boolean } | void> =>
    ipcRenderer.invoke(IPC.command, command),
  listModels: (): Promise<{ id: string; displayName: string; hasKey: boolean }[]> =>
    ipcRenderer.invoke(IPC.listModels),
  getProjectDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.getProjectDir),
  pickProjectDir: (): Promise<string | null> => ipcRenderer.invoke(IPC.pickProjectDir),
  onEvent: (listener: (event: CoreEvent) => void): (() => void) => {
    const wrapped = (_: unknown, event: CoreEvent) => listener(event)
    ipcRenderer.on(IPC.event, wrapped)
    return () => ipcRenderer.off(IPC.event, wrapped)
  },
}

export type WhycodeApi = typeof api

contextBridge.exposeInMainWorld('whycode', api)
