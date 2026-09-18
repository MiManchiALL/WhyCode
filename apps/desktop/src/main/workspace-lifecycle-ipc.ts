import { BrowserWindow, ipcMain, shell } from 'electron'
import type { WorkspaceBinding } from '@whycode/core'
import { validateSessionId } from '@whycode/core'
import { IPC } from '../shared/ipc.ts'
import type { RetainedWorkspaceTarget } from '../shared/workspace-lifecycle.ts'
import type { WorkspaceLifecycle } from './workspace-lifecycle.ts'

export function registerWorkspaceLifecycleIpc(
  lifecycle: WorkspaceLifecycle,
  sessionWorkspace: (sessionId: string) => Promise<WorkspaceBinding | undefined>,
): void {
  const handle = <Args extends unknown[]>(channel: string, operation: (...args: Args) => Promise<unknown>) => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) {
          throw new Error('仅主页面可管理工作区')
        }
        return { ok: true, value: await operation(...args as Args) }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  }
  handle(IPC.previewSessionDeletion, async (sessionId: string) => {
    validateSessionId(sessionId)
    return lifecycle.preview(sessionId, await sessionWorkspace(sessionId))
  })
  handle(IPC.listRetainedWorkspaces, () => lifecycle.list())
  handle(IPC.previewRetainedWorkspace, (target: RetainedWorkspaceTarget) => lifecycle.previewRetained(target))
  handle(IPC.openRetainedWorkspace, (target: RetainedWorkspaceTarget) => lifecycle.openRetained(target, async directory => {
    const error = await shell.openPath(directory)
    if (error) throw new Error(error)
  }))
  handle(IPC.renameRetainedWorkspace, (target: RetainedWorkspaceTarget, name: string) => {
    if (typeof name !== 'string') throw new Error('工作区名称无效')
    return lifecycle.renameRetained(target, name)
  })
  handle(IPC.deleteRetainedWorkspace, (target: RetainedWorkspaceTarget) => lifecycle.deleteRetained(target))
}
