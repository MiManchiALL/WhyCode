import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, GitCommitHorizontal } from 'lucide-react'
import { GIT_HISTORY_PAGE_SIZE, type GitHistory } from '../../shared/git.ts'

export function GitHistoryList({ runtimeId, head, selected, onSelect }: {
  runtimeId: string; head: string | null; selected: string | null; onSelect: (hash: string) => void
}) {
  const [skip, setSkip] = useState(0)
  const [history, setHistory] = useState<GitHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    setHistory(null); setError(null)
    void window.whycode.gitHistory(runtimeId, skip).then(result => {
      if (!active) return
      if (result.ok) setHistory(result.value)
      else setError(result.error)
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [runtimeId, head, skip, retry])
  return <div className="wc-git-history">
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--wc-muted)]">
      <span className="min-w-0 flex-1 truncate">提交历史 · 当前分支</span>
      <span className="tabular-nums">第 {skip / GIT_HISTORY_PAGE_SIZE + 1} 页</span>
      <button type="button" className="wc-preview-action" disabled={!skip || !history} aria-label="较新的提交" onClick={() => setSkip(skip - GIT_HISTORY_PAGE_SIZE)}><ChevronLeft size={13} /></button>
      <button type="button" className="wc-preview-action" disabled={!history?.hasMore} aria-label="更早的提交" onClick={() => setSkip(skip + GIT_HISTORY_PAGE_SIZE)}><ChevronRight size={13} /></button>
    </div>
    <div className="wc-scrollbar wc-git-history-list">
      {history?.commits.map(commit => <button key={commit.hash} type="button" className="wc-git-commit wc-focus-ring" data-selected={selected === commit.hash}
        title={`${commit.subject}\n${commit.hash}\n${commit.author} · ${new Date(commit.date).toLocaleString()}${commit.parents.length > 1 ? '\n合并提交：与第一父提交比较' : ''}`}
        onClick={() => onSelect(commit.hash)}>
        <GitCommitHorizontal size={15} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{commit.subject}</span>
        <span className="shrink-0 font-mono text-[var(--wc-faint)]">{commit.hash.slice(0, 7)}</span>
      </button>)}
      {error ? <button className="p-3 text-xs text-[var(--wc-danger)]" title={error} onClick={() => setRetry(value => value + 1)}>读取失败，点击重试</button>
        : !history ? <p className="p-3 text-xs text-[var(--wc-faint)]">正在读取提交…</p>
          : !history.commits.length && <p className="p-3 text-xs text-[var(--wc-faint)]">尚无提交</p>}
    </div>
  </div>
}
