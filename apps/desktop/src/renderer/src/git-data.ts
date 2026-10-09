import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitComparison, GitSnapshot } from '../../shared/git.ts'

export interface GitData {
  snapshot: GitSnapshot | null
  loading: boolean
  error: string | null
  refresh: () => void
}

export function useGitSnapshot(runtimeId: string, comparison: GitComparison, revision: string | number, enabled = true): GitData {
  const query = JSON.stringify(comparison)
  const key = `${runtimeId}:${query}`
  const [state, setState] = useState<{ key: string; snapshot: GitSnapshot | null; loading: boolean; error: string | null }>(
    { key, snapshot: null, loading: true, error: null })
  const refreshRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => refreshRef.current(), [])
  useEffect(() => {
    if (!enabled || !runtimeId) return
    let active = true, running = false, dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      dirty = true
      if (running) return
      running = true
      setState(previous => ({ key, snapshot: previous.key === key ? previous.snapshot : null, loading: true, error: null }))
      while (dirty && active) {
        dirty = false
        try {
          const result = await window.whycode.gitSnapshot(runtimeId, JSON.parse(query) as GitComparison)
          if (active && !dirty) setState(previous => result.ok
            ? { key, snapshot: result.value, loading: false, error: null }
            : { key, snapshot: previous.key === key ? previous.snapshot : null, loading: false, error: result.error })
        } catch (error) {
          if (active && !dirty) setState(previous => ({ key, snapshot: previous.key === key ? previous.snapshot : null,
            loading: false, error: error instanceof Error ? error.message : String(error) }))
        }
      }
      running = false
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void read(), 120) }
    refreshRef.current = schedule
    schedule()
    return () => { active = false; clearTimeout(timer); refreshRef.current = () => {} }
  }, [runtimeId, query, enabled])
  useEffect(refresh, [revision, refresh])
  return { ...(state.key === key ? state : { snapshot: null, loading: true, error: null }), refresh }
}
