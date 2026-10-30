import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitComparison, GitSnapshot } from '../../shared/git.ts'
import type { SshConnectionStatus } from '../../shared/ssh.ts'

export interface GitData {
  snapshot: GitSnapshot | null
  loading: boolean
  error: string | null
  unavailableReason: string | null
  refresh: () => void
}

export function gitConnectionUnavailableReason(status: SshConnectionStatus | undefined, loading: boolean): string | null {
  if (loading) return '正在读取 SSH 连接状态…'
  switch (status) {
    case 'connected': return null
    case 'connecting': return 'SSH 正在连接…'
    case 'interrupted': return 'SSH 连接已中断，请重新连接'
    case 'releasing': return 'SSH 正在清理，请稍后重新连接'
    case 'disconnected': return 'SSH 未连接，请先连接服务器'
    case undefined: return 'SSH 未配置，请在设置中添加连接'
  }
}

export function useGitSnapshot(runtimeId: string, comparison: GitComparison, revision: string | number, enabled = true, unavailableReason: string | null = null): GitData {
  const query = JSON.stringify(comparison)
  const key = `${runtimeId}:${query}`
  const [state, setState] = useState<{ key: string; snapshot: GitSnapshot | null; loading: boolean; error: string | null }>(
    { key, snapshot: null, loading: true, error: null })
  const refreshRef = useRef<() => void>(() => {})
  const refresh = useCallback(() => refreshRef.current(), [])
  useEffect(() => {
    if (!enabled || unavailableReason || !runtimeId) return
    let active = true, running = false, dirty = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (running) return
      running = true
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
    const schedule = () => {
      dirty = true
      setState(previous => ({ key, snapshot: previous.key === key ? previous.snapshot : null, loading: true, error: null }))
      clearTimeout(timer)
      if (!running) timer = setTimeout(() => void read(), 120)
    }
    refreshRef.current = schedule
    schedule()
    return () => { active = false; clearTimeout(timer); refreshRef.current = () => {} }
  }, [runtimeId, query, enabled, unavailableReason])
  useEffect(refresh, [revision, refresh])
  return { ...(state.key === key ? state : { snapshot: null, loading: true, error: null }), unavailableReason, refresh }
}
