import type { CheckpointFilePreview } from '@whycode/core'
import { useEffect, useRef, useState } from 'react'
import type {
  CheckpointFileCurrentMatchResult,
  CheckpointFilePreviewResult,
} from '../../shared/session.ts'

export type CheckpointPreviewLoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; preview: CheckpointFilePreview }

export type CheckpointCurrentMatchLoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; matches: boolean }

const pendingCheckpointPreviews = new Map<string, Promise<CheckpointFilePreviewResult>>()
const pendingCheckpointCurrentMatches = new Map<
  string,
  Promise<CheckpointFileCurrentMatchResult>
>()

export function useCheckpointFilePreview(
  runtimeId: string,
  toolUseId: string,
  path: string,
): CheckpointPreviewLoadState {
  const [state, setState] = useState<CheckpointPreviewLoadState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void requestCheckpointPreview(runtimeId, toolUseId, path).then((result) => {
      if (!active) return
      setState(result.ok
        ? { status: 'ready', preview: result.preview }
        : { status: 'error', message: result.error })
    }).catch((error) => {
      if (!active) return
      setState({ status: 'error', message: errorMessage(error) })
    })
    return () => { active = false }
  }, [path, runtimeId, toolUseId])
  return state
}

export function useCheckpointFileCurrentMatch(
  runtimeId: string,
  toolUseId: string,
  path: string,
  refreshRevision: string,
): CheckpointCurrentMatchLoadState {
  const [state, setState] = useState<CheckpointCurrentMatchLoadState>({ status: 'loading' })
  const resourceKey = `${runtimeId}\u0000${toolUseId}\u0000${path}`
  const resourceKeyRef = useRef(resourceKey)
  useEffect(() => {
    let active = true
    if (resourceKeyRef.current !== resourceKey) {
      resourceKeyRef.current = resourceKey
      setState({ status: 'loading' })
    }
    void requestCheckpointCurrentMatch(
      runtimeId,
      toolUseId,
      path,
      refreshRevision,
    ).then((result) => {
      if (!active) return
      setState(result.ok
        ? { status: 'ready', matches: result.matches }
        : { status: 'error' })
    }).catch(() => {
      if (!active) return
      setState({ status: 'error' })
    })
    return () => { active = false }
  }, [path, refreshRevision, resourceKey, runtimeId, toolUseId])
  return state
}

function requestCheckpointPreview(
  runtimeId: string,
  toolUseId: string,
  path: string,
): Promise<CheckpointFilePreviewResult> {
  const key = `${runtimeId}\u0000${toolUseId}\u0000${path}`
  const pending = pendingCheckpointPreviews.get(key)
  if (pending) return pending
  const request = window.whycode.checkpointFilePreview({ runtimeId, toolUseId, path })
  pendingCheckpointPreviews.set(key, request)
  void request.finally(() => pendingCheckpointPreviews.delete(key)).catch(() => {})
  return request
}

function requestCheckpointCurrentMatch(
  runtimeId: string,
  toolUseId: string,
  path: string,
  refreshRevision: string,
): Promise<CheckpointFileCurrentMatchResult> {
  const key = `${runtimeId}\u0000${toolUseId}\u0000${path}\u0000${refreshRevision}`
  const pending = pendingCheckpointCurrentMatches.get(key)
  if (pending) return pending
  const request = window.whycode.checkpointFileCurrentMatch({ runtimeId, toolUseId, path })
  pendingCheckpointCurrentMatches.set(key, request)
  void request.finally(() => pendingCheckpointCurrentMatches.delete(key)).catch(() => {})
  return request
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
