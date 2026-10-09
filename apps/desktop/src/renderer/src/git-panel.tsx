import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { largeGitChanges, type GitComparison, type GitFilePreview, type GitFileChange, type GitChanges } from '../../shared/git.ts'
import { gitPageComparison, type GitPage, type RightPanelPage } from './right-panel-state.ts'
import { useGitSnapshot, type GitData } from './git-data.ts'
import { GitActions } from './git-actions.tsx'
import { GitHistoryList } from './git-history.tsx'
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
const captions = { branch: '包含未提交改动', uncommitted: 'HEAD → 工作区', unstaged: '暂存区 → 工作区', staged: 'HEAD → 暂存区', commit: '与第一父提交比较' }

export function GitPanel({ runtimeId, page, branchData, revision, busy, remote, onOpenPage }: {
  runtimeId: string; page: GitPage; branchData: GitData; revision: string; busy: boolean; remote?: boolean
  onOpenPage: (page: RightPanelPage) => void
}) {
  const comparison = gitPageComparison(page)
  const selected = useGitSnapshot(runtimeId, comparison, revision, page.mode !== 'branch' && (page.mode !== 'commit' || !!page.commit))
  const data = page.mode === 'branch' ? branchData : selected
  const repo = data.snapshot?.repository ?? branchData.snapshot?.repository
  const update = (patch: Partial<GitPage>) => onOpenPage({ ...page, ...patch })
  const refresh = () => { branchData.refresh(); selected.refresh() }
  return <div className="wc-git-panel wc-changes-panel flex min-h-0 flex-1 flex-col">
    <div className="wc-git-toolbar">
      <SelectMenu value={page.mode} options={modes} ariaLabel="变更范围" onValueChange={mode => update({ mode: mode as GitPage['mode'],
        commit: mode === 'commit' ? page.commit ?? repo?.head ?? null : page.commit, expandedPaths: [], selectedPath: null })} />
      {page.mode === 'branch' && repo && <div className="wc-git-comparison" title={descriptions.branch}>
        <span className="wc-git-current-branch" title={repo.branch ?? 'HEAD'}>{repo.branch ?? 'HEAD'}</span><span className="text-[var(--wc-faint)]">→</span>
        <SelectMenu value={page.baseRef ?? repo.defaultBase ?? 'HEAD'} options={[
          ...(repo.defaultBase || repo.refs.some(ref => ref.name === repo.branch) ? [] : [{ value: 'HEAD', label: repo.head ? 'HEAD' : '尚无提交' }]),
          ...repo.refs.map(ref => ({ value: ref.ref, label: ref.name })),
        ]} searchable disabled={!repo.head} ariaLabel="比较基准" onValueChange={baseRef => update({ baseRef, expandedPaths: [], selectedPath: null })} className="min-w-0 flex-1" />
      </div>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <button type="button" className="wc-preview-action" aria-label="刷新 Git" title="刷新 Git" disabled={data.loading} onClick={refresh}><RefreshCw size={14} className={data.loading ? 'animate-spin' : ''} /></button>
        {repo && <GitActions key={runtimeId} runtimeId={runtimeId} repository={repo} busy={busy || data.loading} onChanged={refresh} />}
      </div>
    </div>
    {page.mode === 'commit' && <GitHistoryList key={`${runtimeId}:${repo?.head ?? ''}`} runtimeId={runtimeId} head={repo?.head ?? null} selected={page.commit}
      onSelect={commit => update({ commit, expandedPaths: [], selectedPath: null })} />}
    <p className="wc-git-description" title={descriptions[page.mode]}>{page.mode === 'commit' && page.commit ? `${page.commit.slice(0, 7)} · ` : ''}{captions[page.mode]}</p>
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
  const index = Math.max(0, changes.files.findIndex(file => file.relativePath === page.selectedPath))
  const current = changes.files[index]
  const { ref, onScroll, overscrollBehaviorY } = useScrollArea(changes)
  const select = (file: GitFileChange) => onOpenPage({ ...page, selectedPath: file.relativePath, expandedPaths: [file.relativePath] })
  useEffect(() => { if (single && current && !changes.files.some(file => file.relativePath === page.selectedPath)) select(current) }, [single, changes, page.selectedPath])
  useEffect(() => { if (single && ref.current) ref.current.scrollTop = 0 }, [single, page.selectedPath])
  return <>
    <div className="wc-changes-summary" title={changes.untracked ? '增删行数不包含未跟踪文件；展开后可查看文件内容。' : undefined}>
      <span className="min-w-0 truncate">{changes.files.length} 个文件{changes.truncated ? '（部分）' : ''}{changes.untracked ? ` · ${changes.untracked} 个未跟踪` : ''}</span>
      <ChangeCounts added={changes.added} removed={changes.removed} />
    </div>
    {single && current && <div className="wc-git-file-picker">
      <SelectMenu value={current.relativePath} options={changes.files.map(file => ({ value: file.relativePath, label: file.relativePath }))}
        searchable ariaLabel="变更文件" onValueChange={value => { const file = changes.files.find(file => file.relativePath === value); if (file) select(file) }} className="min-w-0 flex-1" />
      <span className="shrink-0 text-xs tabular-nums text-[var(--wc-faint)]">{index + 1}/{changes.files.length}</span>
      <button type="button" className="wc-preview-action" disabled={index === 0} aria-label="上一个变更文件" onClick={() => select(changes.files[index - 1]!)}><ChevronLeft size={14} /></button>
      <button type="button" className="wc-preview-action" disabled={index === changes.files.length - 1} aria-label="下一个变更文件" onClick={() => select(changes.files[index + 1]!)}><ChevronRight size={14} /></button>
    </div>}
    <div ref={ref} onScroll={onScroll} style={{ overscrollBehaviorY }} className="wc-changes-scroll wc-scrollbar min-h-0 flex-1 overflow-y-auto">
      {!changes.files.length && <FilePreviewMessage>没有变更</FilePreviewMessage>}
      {(single ? current ? [current] : [] : changes.files).map(file => <ChangedFile key={file.relativePath} change={file} runtimeId={runtimeId} remote={remote}
        projectDir={root} onOpenPage={onOpenPage} expanded={page.expandedPaths.includes(file.relativePath)}
        label={file.binary ? '二进制' : ({ '?': '未跟踪', R: '重命名', U: '冲突', D: '删除', A: '新增' })[file.status]}
        onToggle={() => onOpenPage({ ...page, expandedPaths: page.expandedPaths.includes(file.relativePath)
          ? page.expandedPaths.filter(path => path !== file.relativePath) : [...page.expandedPaths, file.relativePath] })}>
        <GitFileDiff runtimeId={runtimeId} comparison={comparison} file={file} revision={changes} />
      </ChangedFile>)}
      {changes.truncated && <p className="wc-git-description">变更清单超过显示上限，仅展示前 2,000 个文件；统计仅覆盖已列出的文件。</p>}
    </div>
  </>
}

function GitFileDiff({ runtimeId, comparison, file, revision }: {
  runtimeId: string; comparison: GitComparison; file: GitFileChange; revision: GitChanges
}) {
  const [preview, setPreview] = useState<GitFilePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const query = JSON.stringify(comparison)
  useEffect(() => {
    let active = true
    setPreview(null); setError(null)
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
