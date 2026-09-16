import type { WhycodeApi } from '../../preload/index.ts'

type FileActionsApi = Pick<WhycodeApi, 'openWorkspaceFile' | 'closeWorkspaceFile' | 'revealWorkspaceFile' | 'openWorkspaceFileExternally'>
export type WorkspaceFileAction = 'open' | 'reveal'

/** 卡片仅在用户点击后借用文件视图，操作结束或导航取消时立即归还。 */
export async function performWorkspaceFileAction(
  api: FileActionsApi, runtimeId: string, path: string, action: WorkspaceFileAction, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const result = await api.openWorkspaceFile({ runtimeId, kind: 'file', path })
  if (!result.ok) throw new Error(result.error)
  try {
    signal.throwIfAborted()
    if (action === 'open') await api.openWorkspaceFileExternally(result.view.id)
    else await api.revealWorkspaceFile(result.view.id)
  } finally { api.closeWorkspaceFile(result.view.id) }
}
