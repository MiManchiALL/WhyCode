import type { WhycodeApi } from '../../preload/index.ts'

type FileActionsApi = Pick<WhycodeApi, 'openWorkspaceFile' | 'closeWorkspaceFile' | 'revealWorkspaceFile' | 'openWorkspaceFileExternally' | 'saveWorkspaceFile'>
export type WorkspaceFileAction = 'open' | 'reveal' | 'save'

/** 卡片仅在用户点击后借用文件视图，操作结束或导航取消时立即归还。 */
export async function performWorkspaceFileAction(
  api: FileActionsApi, runtimeId: string, path: string, action: WorkspaceFileAction, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const result = await api.openWorkspaceFile({ runtimeId, kind: 'file', path })
  if (!result.ok) throw new Error(result.error)
  const cancel = () => api.closeWorkspaceFile(result.view.id)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    signal.throwIfAborted()
    if (action === 'save') await api.saveWorkspaceFile(result.view.id)
    else if (action === 'open') await api.openWorkspaceFileExternally(result.view.id)
    else await api.revealWorkspaceFile(result.view.id)
  } finally { signal.removeEventListener('abort', cancel); api.closeWorkspaceFile(result.view.id) }
}
