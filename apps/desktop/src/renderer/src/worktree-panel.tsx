import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorktreeWorkspaceBinding } from '@whycode/core'
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  GitCommitHorizontal,
} from 'lucide-react'
import type { WorktreeStatus } from '../../shared/workspace.ts'

interface WorktreeEnvironmentMenuProps {
  runtimeId: string
  binding: WorktreeWorkspaceBinding
  busy: boolean
  statusRevision: number
  onPrepareCommitPrompt: () => void
}

export function WorktreeEnvironmentMenu(props: WorktreeEnvironmentMenuProps) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionPending, setActionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')
  const [changesExpanded, setChangesExpanded] = useState(false)
  const refreshSequence = useRef(0)
  const loaded = useRef(false)

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current
    if (!loaded.current) setLoading(true)
    try {
      const result = await window.whycode.worktreeStatus(props.runtimeId)
      if (sequence !== refreshSequence.current) return
      if (result.ok) {
        setStatus(result.value)
        setError(null)
      } else {
        setError(result.error)
      }
    } catch (cause) {
      if (sequence !== refreshSequence.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (sequence === refreshSequence.current) {
        loaded.current = true
        setLoading(false)
      }
    }
  }, [props.runtimeId])

  useEffect(() => {
    // 一次模型步骤可能连续提交多个状态事件；短暂合并，只执行一次 Git 状态读取。
    const timer = window.setTimeout(() => void refresh(), loaded.current ? 120 : 0)
    return () => window.clearTimeout(timer)
  }, [props.statusRevision, refresh])

  useEffect(() => {
    const refreshOnFocus = () => void refresh()
    window.addEventListener('focus', refreshOnFocus)
    return () => window.removeEventListener('focus', refreshOnFocus)
  }, [refresh])

  const createBranch = useCallback(async () => {
    const nextBranch = branchName.trim()
    if (!nextBranch) return
    setActionPending(true)
    setError(null)
    try {
      const result = await window.whycode.createWorktreeBranch(props.runtimeId, nextBranch)
      if (result.ok) {
        setBranchName('')
        await refresh()
      } else {
        setError(result.error)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setActionPending(false)
    }
  }, [branchName, props.runtimeId, refresh])

  const locked = props.busy || actionPending || loading
  const changesLabel = loading
    ? '读取中…'
    : status?.dirty
      ? `${status.entries.length}${status.entriesTruncated ? '+' : ''} 项变化`
      : '工作区干净'
  const detached = status ? !status.branch : false

  return (
    <div className="px-2 pb-1">
      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-[var(--wc-ink)]">
          {status?.branch ?? 'detached HEAD'}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--wc-muted)]" title={props.binding.worktreeDirectory}>
          {props.binding.worktreeDirectory}
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-[#eee2dc] px-2.5 py-2 text-[11px] text-[var(--wc-danger)]" role="alert">
          {error}
        </p>
      )}

      <div className="mt-2 border-t border-[var(--wc-line)]">
        <button
          type="button"
          className="wc-focus-ring flex w-full items-center gap-2 py-2.5 text-left text-xs"
          onClick={() => setChangesExpanded((value) => !value)}
          aria-expanded={changesExpanded}
        >
          <FileDiff size={14} />
          <span className="flex-1">变更</span>
          <span className="text-[10px] text-[var(--wc-muted)]">{changesLabel}</span>
          {changesExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {changesExpanded && (
          <div className="border-t border-dashed border-[var(--wc-line)] py-3">
            {status?.entries.length ? (
              <ul className="wc-scrollbar max-h-40 space-y-1 overflow-y-auto font-mono text-[10px]">
                {status.entries.map((entry, index) => (
                  <li key={`${entry.code}:${entry.path}:${index}`} className="flex gap-2">
                    <span className="w-5 shrink-0 text-[var(--wc-sand-ink)]">{entry.code}</span>
                    <span className="break-all text-[var(--wc-muted)]">{entry.path}</span>
                  </li>
                ))}
                {status.entriesTruncated && <li className="text-[var(--wc-faint)]">其余项目已省略…</li>}
              </ul>
            ) : (
              <div className="flex items-center gap-1.5 text-[11px] text-[var(--wc-muted)]">
                <Check size={13} className="text-[#66806d]" />
                {loading ? '正在读取变化' : '没有未提交变化'}
              </div>
            )}
            {status?.diff && (
              <pre className="wc-scrollbar mt-2 max-h-52 overflow-auto rounded-xl bg-[#30322f] p-2.5 text-[10px] leading-4 text-[#eeeeea]">
                {status.diff}{status.diffTruncated ? '\n\n[差异输出已截断]' : ''}
              </pre>
            )}
          </div>
        )}
      </div>

      {detached && (
        <div className="border-t border-[var(--wc-line)] py-3">
          <label className="text-[11px] font-medium text-[var(--wc-muted)]" htmlFor="worktree-branch-name">
            创建分支
          </label>
          <div className="mt-1.5 flex gap-1.5">
            <input
              id="worktree-branch-name"
              className="wc-focus-ring min-w-0 flex-1 rounded-xl border border-[var(--wc-line)] bg-white/85 px-2.5 py-1.5 text-xs outline-none"
              value={branchName}
              onChange={(event) => setBranchName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void createBranch()
                }
              }}
              placeholder="feature/task-name"
              disabled={locked}
            />
            <button
              type="button"
              className="wc-focus-ring rounded-xl bg-[var(--wc-sage-ink)] px-2.5 py-1.5 text-xs text-white disabled:opacity-40"
              onClick={() => void createBranch()}
              disabled={locked || !branchName.trim()}
            >
              创建
            </button>
          </div>
          <p className="mt-1.5 text-[10px] leading-4 text-[var(--wc-faint)]">
            创建分支不会自动提交；后续提交可在原仓库中合并。
          </p>
        </div>
      )}

      <button
        type="button"
        className="wc-focus-ring flex w-full items-center gap-2 border-t border-[var(--wc-line)] py-2.5 text-left text-xs transition-colors hover:text-[var(--wc-sage-ink)] disabled:opacity-40"
        onClick={props.onPrepareCommitPrompt}
        disabled={locked || detached || !status}
        title={!status
          ? '正在读取 Worktree 状态'
          : detached
            ? '请先创建分支'
            : '将提交或推送请求放入输入框，确认后再发送'}
      >
        <GitCommitHorizontal size={14} />
        <span className="flex-1">提交或推送</span>
        <ArrowUpRight size={13} />
      </button>
    </div>
  )
}
