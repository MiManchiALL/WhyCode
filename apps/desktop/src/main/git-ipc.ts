import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '../shared/ipc.ts'
import { gitComparisonSchema, gitMutationSchema, type GitMutation } from '../shared/git.ts'
import type { WorkspaceActionResult } from '../shared/workspace.ts'
import { readGitFilePreview } from './git-changes.ts'
import type { GitRepository } from './git-repository.ts'
import { readGitSnapshot } from './git-snapshot.ts'

export function registerGitIpc(
  repositoryFor: (runtimeId: string) => Promise<GitRepository | null>,
  mutate: (runtimeId: string, mutation: GitMutation) => Promise<string>,
): void {
  const invoke = async <T>(event: IpcMainInvokeEvent, runtimeId: unknown, operation: (id: string) => Promise<T>): Promise<WorkspaceActionResult<T>> => {
    try {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error('仅主页面可操作 Git')
      const id = z.string().min(1).max(200).parse(runtimeId)
      return { ok: true, value: await operation(id) } as WorkspaceActionResult<T>
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  }
  ipcMain.handle(IPC.gitSnapshot, (event, id: unknown, value: unknown) => invoke(event, id, async runtimeId => {
    const comparison = gitComparisonSchema.parse(value)
    return readGitSnapshot(repositoryFor(runtimeId), comparison)
  }))
  ipcMain.handle(IPC.gitFilePreview, (event, id: unknown, value: unknown, path: unknown) => invoke(event, id, async runtimeId => {
    const comparison = gitComparisonSchema.parse(value)
    const relativePath = z.string().min(1).max(4096).refine(value => !value.includes('\0')).parse(path)
    const repo = await repositoryFor(runtimeId)
    if (!repo) throw new Error('当前工作路径不是 Git 仓库')
    return readGitFilePreview(repo, await repo.info(), comparison, relativePath)
  }))
  ipcMain.handle(IPC.gitHistory, (event, id: unknown, value: unknown) => invoke(event, id, async runtimeId => {
    const skip = z.number().int().min(0).max(100_000).parse(value)
    const repo = await repositoryFor(runtimeId)
    if (!repo) throw new Error('当前工作路径不是 Git 仓库')
    return repo.history(skip)
  }))
  ipcMain.handle(IPC.gitMutate, (event, id: unknown, value: unknown) => invoke(event, id, runtimeId => mutate(runtimeId, gitMutationSchema.parse(value))))
}
