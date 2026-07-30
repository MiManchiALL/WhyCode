import { useCallback, useEffect, useState } from 'react'
import type { WorktreeWorkspaceBinding } from '@whycode/core'
import {
  workspaceDisplayDirectory,
  type WorktreeStatus,
} from '../../shared/workspace.ts'

interface WorktreePanelProps {
  runtimeId: string
  binding: WorktreeWorkspaceBinding
  busy: boolean
  onClose: () => void
  onDiscard: () => void
}

export function WorktreePanel(props: WorktreePanelProps) {
  const [status, setStatus] = useState<WorktreeStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionPending, setActionPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [branchName, setBranchName] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const result = await window.whycode.worktreeStatus(props.runtimeId)
    if (result.ok) {
      setStatus(result.value)
      setError(null)
    } else {
      setError(result.error)
    }
    setLoading(false)
  }, [props.runtimeId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const createBranch = useCallback(async () => {
    if (!branchName.trim()) return
    setActionPending(true)
    const result = await window.whycode.createWorktreeBranch(
      props.runtimeId,
      branchName.trim(),
    )
    if (result.ok) {
      setBranchName('')
      await refresh()
    } else {
      setError(result.error)
    }
    setActionPending(false)
  }, [branchName, props.runtimeId, refresh])

  const openFolder = useCallback(async () => {
    const result = await window.whycode.openWorkspaceFolder(props.runtimeId)
    if (!result.ok) setError(result.error)
  }, [props.runtimeId])

  const locked = props.busy || actionPending
  const hasDetachedCommits = Boolean(
    status
    && !status.branch
    && status.headCommit !== props.binding.baseCommit,
  )
  return (
    <div className="absolute inset-0 z-30 flex bg-black/20" onClick={props.onClose}>
      <aside
        className="ml-auto h-full w-[34rem] overflow-y-auto border-l border-neutral-200 bg-white p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">隔离 Worktree</h2>
              <span className="rounded bg-violet-100 px-2 py-0.5 text-[11px] text-violet-700">
                受管
              </span>
            </div>
            <p className="mt-1 text-[11px] text-neutral-400">
              建立会话后默认持续保留；未发送内容且保持干净的临时草稿会自动清理。
            </p>
          </div>
          <button className="text-sm text-neutral-400 hover:text-neutral-700" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <dl className="mt-5 space-y-2 rounded-lg bg-neutral-50 p-3 text-xs">
          <WorkspaceFact label="执行目录" value={workspaceDisplayDirectory(props.binding)!} />
          <WorkspaceFact label="原仓库" value={props.binding.repositoryDirectory} />
          <WorkspaceFact
            label="创建基线"
            value={`${props.binding.baseRef ?? 'detached HEAD'} · ${props.binding.baseCommit.slice(0, 10)}`}
          />
          <WorkspaceFact
            label="当前 HEAD"
            value={status
              ? `${status.branch ?? 'detached'} · ${status.headCommit.slice(0, 10)}`
              : loading ? '读取中…' : '未知'}
          />
        </dl>

        {error && (
          <p className="mt-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded border border-neutral-300 px-3 py-1.5 text-xs hover:border-neutral-500"
            onClick={openFolder}
          >
            打开文件夹
          </button>
          <button
            className="rounded border border-neutral-300 px-3 py-1.5 text-xs hover:border-neutral-500 disabled:opacity-40"
            onClick={() => void refresh()}
            disabled={loading}
          >
            {loading ? '刷新中…' : '刷新状态'}
          </button>
        </div>

        {status && !status.branch && (
          <section className="mt-5 rounded-lg border border-violet-200 p-3">
            <h3 className="text-xs font-semibold text-violet-800">保留成果到分支</h3>
            <p className="mt-1 text-[11px] leading-5 text-neutral-500">
              创建分支不会自动提交；已有提交和后续提交会在原仓库中可见，可再自行合并。
            </p>
            <div className="mt-3 flex gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1.5 text-xs outline-none focus:border-violet-400"
                value={branchName}
                onChange={(event) => setBranchName(event.target.value)}
                placeholder="例如 feature/whycode-task"
                disabled={locked}
              />
              <button
                className="rounded bg-violet-700 px-3 py-1.5 text-xs text-white disabled:opacity-40"
                onClick={() => void createBranch()}
                disabled={locked || !branchName.trim()}
              >
                创建分支
              </button>
            </div>
          </section>
        )}

        <section className="mt-5">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold">工作区变化</h3>
            {status && (
              <span className={`text-[11px] ${status.dirty ? 'text-amber-700' : 'text-emerald-700'}`}>
                {status.dirty
                  ? `${status.entries.length}${status.entriesTruncated ? '+' : ''} 项变化`
                  : hasDetachedCommits ? '有未建分支的提交' : '干净'}
              </span>
            )}
          </div>
          {hasDetachedCommits && (
            <p className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              当前 detached HEAD 已偏离创建基线；请先创建分支，避免删除 Worktree 后失去提交引用。
            </p>
          )}
          {status?.entries.length ? (
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded bg-neutral-50 p-2 font-mono text-[11px]">
              {status.entries.map((entry, index) => (
                <li key={`${entry.code}:${entry.path}:${index}`} className="flex gap-2">
                  <span className="w-5 shrink-0 text-amber-700">{entry.code}</span>
                  <span className="break-all">{entry.path}</span>
                </li>
              ))}
              {status.entriesTruncated && <li className="text-neutral-400">其余项目已省略…</li>}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-neutral-400">
              {loading ? '正在读取…' : '没有未提交变化'}
            </p>
          )}
          {status?.diff && (
            <pre className="mt-3 max-h-80 overflow-auto rounded bg-neutral-950 p-3 text-[11px] leading-5 text-neutral-100">
              {status.diff}{status.diffTruncated ? '\n\n[差异输出已截断]' : ''}
            </pre>
          )}
        </section>

        <section className="mt-6 border-t border-red-100 pt-4">
          {confirmDiscard ? (
            <div className="rounded bg-red-50 p-3 text-xs text-red-700">
              <p>
                这会停止并删除本会话，永久丢弃 Worktree 中未提交的文件变化。
                未创建分支的 detached 提交也会失去 Worktree 引用；已创建的 Git 分支及其提交仍保留。
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  className="rounded bg-red-600 px-3 py-1.5 text-white disabled:opacity-40"
                  onClick={props.onDiscard}
                  disabled={locked}
                >
                  确认丢弃
                </button>
                <button
                  className="rounded border border-red-200 bg-white px-3 py-1.5"
                  onClick={() => setConfirmDiscard(false)}
                  disabled={actionPending}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              className="text-xs text-red-500 hover:text-red-700 disabled:opacity-40"
              onClick={() => setConfirmDiscard(true)}
              disabled={locked}
            >
              丢弃 Worktree 与会话…
            </button>
          )}
        </section>
      </aside>
    </div>
  )
}

function WorkspaceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[5rem_1fr] gap-2">
      <dt className="text-neutral-400">{label}</dt>
      <dd className="break-all font-mono text-neutral-700">{value}</dd>
    </div>
  )
}
