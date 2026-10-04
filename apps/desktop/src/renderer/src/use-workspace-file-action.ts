import { useEffect, useRef, useState } from 'react'
import { performWorkspaceFileAction, type WorkspaceFileAction } from './workspace-file-actions.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'

export function useWorkspaceFileAction(runtimeId: string, path: string) {
  const [pending, setPending] = useState(false)
  const feedback = useConversationFeedback()
  const request = useRef<AbortController | null>(null)
  useEffect(() => {
    setPending(false)
    return () => { request.current?.abort(); request.current = null }
  }, [runtimeId, path])
  const run = async (action: WorkspaceFileAction) => {
    if (request.current) return false
    const abort = new AbortController()
    request.current = abort
    setPending(true)
    try {
      await performWorkspaceFileAction(window.whycode, runtimeId, path, action, abort.signal)
      return !abort.signal.aborted
    } catch (error) {
      if (!abort.signal.aborted) feedback('error', error instanceof Error ? error.message : String(error))
      return false
    } finally {
      if (!abort.signal.aborted) { request.current = null; setPending(false) }
    }
  }
  return { pending, run }
}
