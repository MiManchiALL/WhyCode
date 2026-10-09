import { useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { largeGitChanges, type GitComparison, type GitFilePreview, type GitFileChange, type GitChanges } from '../../shared/git.ts'
import { gitPageComparison, type GitPage, type RightPanelPage } from './right-panel-state.ts'
import { useGitSnapshot, type GitData } from './git-data.ts'
import { GitActions } from './git-actions.tsx'
import { GitHistoryPicker } from './git-history.tsx'
import { gitComparisonRefs, gitOverviewPage } from './git-comparison.ts'
import { SelectMenu } from './select-menu.tsx'
import { ChangedFile } from './changed-file.tsx'
import { ChangeCounts } from './file-change-summary.tsx'
import { FileDiff } from './file-diff.tsx'
import { FilePreviewMessage } from './file-preview-controls.tsx'
import { useScrollArea } from './use-scroll-area.ts'

const modes = [{ value: 'branch', label: '分支' }, { value: 'uncommitted', label: '未提交' },
  { value: 'unstaged', label: '未暂存' }, { value: 'staged', label: '已暂存' }, { value: 'commit', label: '已提交' }]
const descriptions = {
  branch: '当前工作区与所选基准直接比较，包含未提交改动；远端分支使用本地已有记录。',
  uncommitted: '与 HEAD 比较，包含已暂存、未暂存和未跟踪文件。',
  unstaged: '工作区与暂存区比较，包含未跟踪文件。', staged: '暂存区与 HEAD 比较。',
  commit: '查看所选提交相对第一父提交的变化；首次提交显示全部新增文件。',
}

export function GitPanel({ runtimeId, page, branchData, revision, busy, remote, onOpenPage }: {
  runtimeId: string; page: GitPage; branchData: GitData; revision: string; busy: boolean; remote?: boolean
  onOpenPage: (page: RightPanelPage) => void
}) {
  const comparison = gitPageComparison(page)
  const selected = useGitSnapshot(runtimeId, comparison, revision, page.mode !== 'branch' && (page.mode !== 'commit' || !!page.commit))
  const data = page.mode === 'branch' ? branchData : selected
  const repo = data.snapshot?.repository ?? branchData.snapshot?.repository
  const changes = data.snapshot?.changes
  const bases = gitComparisonRefs(repo)
  const update = (patch: Partial<GitPage>) => onOpenPage({ ...page, ...patch })
  const refresh = () => { branchData.refresh(); selected.refresh() }
  useEffect(() => {
    if (page.mode === 'branch' && repo && !branchData.loading && !bases.some(ref => ref.ref === (page.baseRef ?? repo.defaultBase))) {
      onOpenPage(gitOverviewPage(page, repo))
    }
  }, [page, repo, branchData.loading, onOpenPage])
  return <div className="wc-git-panel wc-changes-panel flex min-h-0 flex-1 flex-col">
    <div className="wc-git-toolbar">
      <div className="wc-git-scope wc-git-control" title={`${descriptions[page.mode]}${changes ? `\n${changes.files.length} 个文件${changes.untracked ? ` · ${changes.untracked} 个未跟踪文件未计入行数` : ''}${changes.truncated ? '（部分）' : ''}` : ''}`}>
        <SelectMenu value={page.mode} options={modes.map(mode => ({ ...mode, disabled: mode.value === 'branch' && !bases.length }))} ariaLabel="变更范围" onValueChange={mode => update({ mode: mode as GitPage['mode'],
          baseRef: mode === 'branch' ? gitOverviewPage(page, repo).baseRef ?? bases[0]?.ref ?? null : page.baseRef,
          commit: mode === 'commit' ? page.commit ?? repo?.head ?? null : page.commit, expandedPaths: [], selectedPath: null })} />
        {changes && <ChangeCounts added={changes.added} removed={changes.removed} />}
      </div>
      {page.mode === 'branch' && repo && bases.length > 0 && <div className="wc-git-comparison wc-git-control" title={descriptions.branch}>
        <span className="wc-git-current-branch" title={repo.branch ?? 'HEAD'}>{repo.branch ?? 'HEAD'}</span><span className="text-[var(--wc-faint)]">→</span>
        <SelectMenu value={page.baseRef ?? repo.defaultBase ?? ''} options={bases.map(ref => ({ value: ref.ref, label: ref.name }))}
          searchable disabled={!repo.head} ariaLabel="比较基准" onValueChange={baseRef => update({ baseRef, expandedPaths: [], selectedPath: null })} className="min-w-0" />
      </div>}
      {page.mode === 'commit' && <GitHistoryPicker key={`${runtimeId}:${repo?.head ?? ''}`} runtimeId={runtimeId} head={repo?.head ?? null} selected={page.commit}
        onSelect={commit => update({ commit, expandedPaths: [], selectedPath: null })} />}
      <div className="wc-git-toolbar-actions flex shrink-0 items-center gap-1">
        <button type="button" className="wc-preview-action" aria-label="刷新 Git" title="刷新 Git" disabled={data.loading} onClick={refresh}><RefreshCw size={14} className={data.loading ? 'animate-spin' : ''} /></button>
        {repo && <GitActions key={runtimeId} runtimeId={runtimeId} repository={repo} busy={busy || data.loading} onChanged={refresh} />}
      </div>
    </div>
    {data.error || data.snapshot?.changesError ? <FilePreviewMessage>{data.error ?? data.snapshot?.changesError}</FilePreviewMessage>
      : page.mode === 'commit' && !page.commit ? <FilePreviewMessage>选择一个提交查看变更</FilePreviewMessage>
        : !data.snapshot ? <FilePreviewMessage>正在读取变更…</FilePreviewMessage>
          : !data.snapshot.repository ? <FilePreviewMessage>当前目录不是 Git 仓库</FilePreviewMessage>
            : data.snapshot.changes && <GitChangeFiles key={JSON.stringify(comparison)} runtimeId={runtimeId} remote={remote} root={data.snapshot.repository.root}
              changes={data.snapshot.changes} comparison={comparison} page={page} onOpenPage={onOpenPage} />}
  </div>
}

function GitChangeFiles({ runtimeId, remote, root, changes, comparison, page, onOpenPage }: {
  runtimeId: string; remote?: boolean; root: string; changes: GitChanges; comparison: GitComparison
  page: GitPage; onOpenPage: (page: RightPanelPage) => void
}) {
  const single = largeGitChanges(changes)
  const current = changes.files.find(file => file.relativePath === page.selectedPath) ?? changes.files[0]
  const { ref, onScroll, overscrollBehaviorY } = useScrollArea(changes)
  const select = (file: GitFileChange) => onOpenPage({ ...page, selectedPath: file.relativePath, expandedPaths: [file.relativePath] })
  useEffect(() => { if (single && current && !changes.files.some(file => file.relativePath === page.selectedPath)) select(current) }, [single, changes, page.selectedPath])
  useEffect(() => { if (single && ref.current) ref.current.scrollTop = 0 }, [single, page.selectedPath])
  return <div ref={ref} onScroll={onScroll} style={{ overscrollBehaviorY }} className="wc-changes-scroll wc-scrollbar min-h-0 flex-1 overflow-y-auto">
      {!changes.files.length && <FilePreviewMessage>没有变更</FilePreviewMessage>}
      {(single ? current ? [current] : [] : changes.files).map(file => <ChangedFile key={file.relativePath} change={file} runtimeId={runtimeId} remote={remote}
        projectDir={root} onOpenPage={onOpenPage} expanded={single || page.expandedPaths.includes(file.relativePath)}
        heading={single ? <div className="wc-git-file-picker" title={file.binary ? '二进制文件' : file.status === '?' ? '未跟踪文件，未计入总行数' : undefined}>
          <SelectMenu value={file.relativePath} options={changes.files.map(entry => ({ value: entry.relativePath, label: entry.relativePath }))}
            searchable ariaLabel="变更文件" onValueChange={value => { const selected = changes.files.find(entry => entry.relativePath === value); if (selected) select(selected) }} className="min-w-0 flex-1" />
          {file.added !== undefined && file.removed !== undefined && <ChangeCounts added={file.added} removed={file.removed} />}
        </div> : undefined}
        label={file.binary ? '二进制' : ({ '?': '未跟踪', R: '重命名', U: '冲突', D: '删除', A: '新增' })[file.status]}
        onToggle={() => onOpenPage({ ...page, expandedPaths: page.expandedPaths.includes(file.relativePath)
          ? page.expandedPaths.filter(path => path !== file.relativePath) : [...page.expandedPaths, file.relativePath] })}>
        <GitFileDiff runtimeId={runtimeId} comparison={comparison} file={file} revision={changes} />
      </ChangedFile>)}
      {changes.truncated && <p className="wc-git-description">变更清单超过显示上限，仅展示前 2,000 个文件；统计仅覆盖已列出的文件。</p>}
    </div>
}

function GitFileDiff({ runtimeId, comparison, file, revision }: {
  runtimeId: string; comparison: GitComparison; file: GitFileChange; revision: GitChanges
}) {
  const [preview, setPreview] = useState<GitFilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = JSON.stringify(comparison)
  useEffect(() => {
    let active = true
    setError(null)
    void window.whycode.gitFilePreview(runtimeId, JSON.parse(query) as GitComparison, file.relativePath).then(result => {
      if (!active) return
      if (result.ok) setPreview(result.value)
      else setError(result.error)
    }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)) })
    return () => { active = false }
  }, [runtimeId, query, file.relativePath, revision])
  if (error) return <FilePreviewMessage>{error}</FilePreviewMessage>
  if (!preview) return <FilePreviewMessage>正在读取差异…</FilePreviewMessage>
  return <FileDiff path={file.path} preview={preview} />
}
