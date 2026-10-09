import { FileDiff, RefreshCw } from 'lucide-react'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import type { GitData } from './git-data.ts'
import { ChangeCounts } from './file-change-summary.tsx'
import { GitActions } from './git-actions.tsx'

export function GitEnvironment({ runtimeId, workspace, data, busy, onOpen }: {
  runtimeId: string; workspace: RuntimeWorkspace; data: GitData; busy: boolean; onOpen: () => void
}) {
  const repo = data.snapshot?.repository
  const changes = data.snapshot?.changes
  if (workspace.mode === 'none' || workspace.mode.startsWith('pending-')) return null
  if (!repo) return <div className="px-2 text-xs text-[var(--wc-faint)]">
    {data.error ? <button className="wc-focus-ring w-full text-left" onClick={data.refresh} title={data.error}>Git 读取失败，点击重试</button>
      : data.loading ? '正在读取仓库…' : '当前目录不是 Git 仓库'}
  </div>
  return <div className="wc-git-environment">
    <div className="wc-git-repository" title={`${repo.root}\n${repo.branch ?? repo.head ?? '尚无提交'}${repo.upstream ? `\n${repo.upstream}: 领先 ${repo.ahead} · 落后 ${repo.behind}` : ''}${repo.conflicts ? `\n${repo.conflicts} 个冲突` : ''}`}>
      <span className="min-w-0 flex-1 truncate font-medium">{repo.name}</span>
      <span className="wc-git-branch-label">{repo.branch ?? `HEAD · ${repo.head?.slice(0, 7)}`}</span>
    </div>
    <div className="wc-git-change-row">
      <button type="button" className="wc-menu-item min-w-0 flex-1" onClick={onOpen}
        title={changes ? `当前工作区相对 ${changes.baseLabel} 的变化（含未提交）${changes.truncated ? '；清单已截断，统计仅覆盖已列出的文件' : ''}${changes.untracked ? '；行数不包含未跟踪文件' : ''}` : '查看仓库变更'}>
        <FileDiff size={14} className="shrink-0" /><span className="min-w-0 flex-1 text-left">变更</span>
        <span className="wc-git-change-counts">
          {changes ? changes.files.length ? changes.added + changes.removed > 0 ? <ChangeCounts added={changes.added} removed={changes.removed} /> : <span className="text-xs text-[var(--wc-faint)]">{changes.files.length} 个文件</span>
            : <span className="text-xs text-[var(--wc-faint)]">无变更</span> : <span className="text-xs text-[var(--wc-faint)]">查看</span>}
          {changes?.truncated && <span className="text-xs text-[var(--wc-faint)]">部分</span>}
        </span>
      </button>
      <GitActions key={runtimeId} runtimeId={runtimeId} repository={repo} busy={busy || data.loading} onChanged={data.refresh} />
    </div>
    {(data.error || data.snapshot?.changesError) && <button type="button" className="wc-git-read-error" onClick={data.refresh}
      title={data.error ?? data.snapshot?.changesError ?? ''}><RefreshCw size={12} />读取未完成，点击重试</button>}
  </div>
}
