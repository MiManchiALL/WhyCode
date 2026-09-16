import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceFileView } from '../../shared/workspace-files.ts'

interface FileState {
  view: WorkspaceFileView | null
  loading: boolean
  changed: boolean
  error: string | null
}
interface Lease { id: string; request: number; revision: number }

export function useWorkspaceFile(runtimeId: string, kind: 'directory' | 'file', path: string, refreshRevision = '') {
  const [state, setState] = useState<FileState>({ view: null, loading: true, changed: false, error: null })
  const lease = useRef<Lease | null>(null)
  const [attempt, setAttempt] = useState(0)
  const lastRevision = useRef(refreshRevision)
  const refresh = useCallback(async (offset = 0) => {
    const current = lease.current
    if (!current) { setAttempt(value => value + 1); return false }
    const request = ++current.request
    const revision = current.revision
    setState(previous => ({ ...previous, loading: true, error: null }))
    try {
      const result = await window.whycode.readWorkspaceFile({ id: current.id, offset })
      if (lease.current !== current || current.request !== request) return false
      if (!result.ok) throw new Error(result.error)
      setState(previous => ({
        ...previous, loading: false, changed: current.revision !== revision, error: null,
        view: offset > 0 && result.view.kind === 'directory' && previous.view?.kind === 'directory'
          ? { ...result.view, entries: [...previous.view.entries, ...result.view.entries] }
          : result.view,
      }))
      return true
    } catch (error) {
      if (lease.current === current && current.request === request) {
        setState(previous => ({ ...previous, loading: false, error: errorMessage(error) }))
      }
      return false
    }
  }, [])

  useEffect(() => {
    let active = true
    setState({ view: null, loading: true, changed: false, error: null })
    const unsubscribe = window.whycode.onWorkspaceFileChanged(change => {
      if (lease.current?.id !== change.id) return
      lease.current.revision++
      setState(previous => ({ ...previous, changed: true }))
      if (kind === 'directory') void refresh()
    })
    void window.whycode.openWorkspaceFile({ runtimeId, kind, path }).then(result => {
      if (!result.ok) throw new Error(result.error)
      if (!active) { window.whycode.closeWorkspaceFile(result.view.id); return }
      lease.current = { id: result.view.id, request: 0, revision: 0 }
      setState({ view: result.view, loading: false, changed: false, error: null })
    }).catch(error => {
      if (active) setState({ view: null, loading: false, changed: false, error: errorMessage(error) })
    })
    return () => {
      active = false
      unsubscribe()
      if (lease.current) window.whycode.closeWorkspaceFile(lease.current.id)
      lease.current = null
    }
  }, [runtimeId, kind, path, refresh, attempt])

  useEffect(() => {
    if (lastRevision.current === refreshRevision) return
    lastRevision.current = refreshRevision
    if (kind === 'directory') void refresh()
  }, [kind, refreshRevision, refresh])

  const reveal = useCallback(() => {
    if (!lease.current) return
    void window.whycode.revealWorkspaceFile(lease.current.id).catch(error => {
      setState(previous => ({ ...previous, error: errorMessage(error) }))
    })
  }, [])
  const openExternally = useCallback(() => {
    if (!lease.current) return
    void window.whycode.openWorkspaceFileExternally(lease.current.id).catch(error => {
      setState(previous => ({ ...previous, error: errorMessage(error) }))
    })
  }, [])
  return { ...state, refresh, reveal, openExternally }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
