import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useConversationFeedback } from './conversation-feedback.tsx'
import { WorkspaceFileResource } from './workspace-file-resource.ts'

export function useWorkspaceFile(runtimeId: string, path: string) {
  const feedback = useConversationFeedback()
  const file = useMemo(() => new WorkspaceFileResource(window.whycode, { runtimeId, kind: 'file', path }), [runtimeId, path])
  const state = useSyncExternalStore(file.subscribe, file.getSnapshot)
  useEffect(() => { file.open(); return () => file.close() }, [file])

  const perform = useCallback((action: 'revealWorkspaceFile' | 'openWorkspaceFileExternally') => {
    const id = file.getSnapshot().view?.id
    if (!id) return
    void window.whycode[action](id).catch(error => {
      if (file.getSnapshot().view?.id === id) feedback('error', error instanceof Error ? error.message : String(error))
    })
  }, [feedback, file])
  const check = async () => {
    const id = file.getSnapshot().view?.id
    if (!id) return false
    try {
      const result = await window.whycode.checkWorkspaceFile(id)
      if (file.getSnapshot().view?.id !== id) return false
      if (!result.ok) feedback('error', result.error)
      return result.ok
    } catch (error) {
      if (file.getSnapshot().view?.id === id) feedback('error', error instanceof Error ? error.message : String(error))
      return false
    }
  }
  const refreshForAction = async () => {
    const ok = await file.refresh(0, 'preserve')
    const error = file.getSnapshot().error
    if (!ok && error) feedback('error', error)
    return ok
  }
  return { ...state, refresh: file.refresh, check, refreshForAction,
    reveal: () => perform('revealWorkspaceFile'), openExternally: () => perform('openWorkspaceFileExternally') }
}
