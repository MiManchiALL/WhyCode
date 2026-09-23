import type { ToolFileChange } from '@whycode/core/events'
import { useEffect, useState } from 'react'

type FileChangesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; changes: ToolFileChange[] }

export function useResponseFileChanges(runtimeId: string, checkpointIds: readonly string[]): FileChangesState {
  const checkpoints = checkpointIds.join(',')
  const [state, setState] = useState<FileChangesState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    if (!checkpoints) { setState({ status: 'ready', changes: [] }); return }
    void window.whycode.checkpointFileChanges({ runtimeId, checkpointIds: checkpoints.split(',') }).then(result => {
      if (active) setState(result.ok ? { status: 'ready', changes: result.changes } : { status: 'error', message: result.error })
    }).catch(error => {
      if (active) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    })
    return () => { active = false }
  }, [runtimeId, checkpoints])
  return state
}

export function totalFileChanges(changes: readonly ToolFileChange[]): { added: number; removed: number } {
  return changes.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 })
}
