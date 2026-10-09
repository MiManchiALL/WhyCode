import { useEffect, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, ChevronLeft, ChevronRight, GitCommitHorizontal } from 'lucide-react'
import { GIT_HISTORY_PAGE_SIZE, type GitHistory } from '../../shared/git.ts'

export function GitHistoryPicker({ runtimeId, head, selected, onSelect }: {
  runtimeId: string; head: string | null; selected: string | null; onSelect: (hash: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [skip, setSkip] = useState(0)
  const [history, setHistory] = useState<GitHistory | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    if (!open || history) return
    let active = true
    setError(null)
    void window.whycode.gitHistory(runtimeId, skip).then(result => {
      if (!active) return
      if (result.ok) setHistory(result.value)
      else setError(result.error)
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [runtimeId, head, skip, retry, open, history])
  const subject = history?.commits.find(commit => commit.hash === selected)?.subject
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger asChild><button type="button" className="wc-select-trigger wc-focus-ring wc-git-history-trigger" aria-label="选择提交" title={subject ?? selected ?? '提交历史'}>
      <GitCommitHorizontal size={14} className="shrink-0" />
      <span className="min-w-0 truncate">{subject ?? selected?.slice(0, 7) ?? '选择提交'}</span><ChevronDown size={13} className="shrink-0 text-[var(--wc-faint)]" />
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="wc-menu-content wc-git-history" align="start" sideOffset={6} collisionPadding={12} aria-label="提交历史">
      <div className="wc-git-history-heading">
        <span className="min-w-0 flex-1 truncate">提交历史</span>
        <span className="tabular-nums">第 {skip / GIT_HISTORY_PAGE_SIZE + 1} 页</span>
        <button type="button" className="wc-preview-action" disabled={!skip || !history} aria-label="较新的提交" onClick={() => { setHistory(null); setSkip(skip - GIT_HISTORY_PAGE_SIZE) }}><ChevronLeft size={13} /></button>
        <button type="button" className="wc-preview-action" disabled={!history?.hasMore} aria-label="更早的提交" onClick={() => { setHistory(null); setSkip(skip + GIT_HISTORY_PAGE_SIZE) }}><ChevronRight size={13} /></button>
      </div>
      <div className="wc-scrollbar wc-git-history-list" key={skip}>
        {history?.commits.map(commit => <button key={commit.hash} type="button" className="wc-git-commit wc-focus-ring" aria-pressed={selected === commit.hash}
          title={`${commit.subject}\n${commit.hash}\n${commit.author} · ${new Date(commit.date).toLocaleString()}${commit.parents.length > 1 ? '\n合并提交：与第一父提交比较' : ''}`}
          onClick={() => { onSelect(commit.hash); setOpen(false) }}>
          <GitCommitHorizontal size={15} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{commit.subject}</span>
          <span className="shrink-0 font-mono text-[var(--wc-faint)]">{commit.hash.slice(0, 7)}</span>
        </button>)}
        {error ? <button className="p-3 text-xs text-[var(--wc-danger)]" title={error} onClick={() => setRetry(value => value + 1)}>读取失败，点击重试</button>
          : !history ? <p className="p-3 text-xs text-[var(--wc-faint)]">正在读取提交…</p>
            : !history.commits.length && <p className="p-3 text-xs text-[var(--wc-faint)]">尚无提交</p>}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
