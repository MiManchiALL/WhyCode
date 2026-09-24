import type { ToolFileChange } from '@whycode/core/events'
import { ChevronRight, FolderOpen, PanelRightOpen } from 'lucide-react'
import { useCallback, useId, useLayoutEffect } from 'react'
import type { RightPanelPage } from './right-panel-state.ts'
import { useResponseFileChanges, totalFileChanges } from './response-file-changes-data.ts'
import { ChangeCounts, ChangedFilePath } from './file-change-summary.tsx'
import { FileDiff } from './file-diff.tsx'
import { fileIcon, FilePreviewMessage } from './file-preview-controls.tsx'
import { useCheckpointFilePreview } from './file-preview-data.ts'
import { fileName, filePathKey } from './local-files.ts'
import { useScrollArea } from './use-scroll-area.ts'
import { useWorkspaceFileAction } from './use-workspace-file-action.ts'

type ChangesPage = Extract<RightPanelPage, { kind: 'changes' }>
interface Props {
  runtimeId: string
  projectDir: string | null
  page: ChangesPage
  onOpenPage: (page: RightPanelPage) => void
}

export function RightPanelChanges(props: Props) {
  const { page, runtimeId, onOpenPage } = props
  const state = useResponseFileChanges(runtimeId, page.checkpointIds)
  const { ref, onScroll, overscrollBehaviorY } = useScrollArea(state, { enabled: state.status === 'ready' })
  const focusSelected = useCallback(() => {
    if (!page.selectedPath) return
    const scroll = ref.current
    const row = scroll?.querySelector<HTMLElement>(`[data-change-path="${CSS.escape(filePathKey(page.selectedPath))}"]`)
    if (row && scroll) scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top
  }, [page.selectedPath])
  useLayoutEffect(focusSelected, [focusSelected, page.expandedPaths, state.status])
  if (state.status === 'loading') return <FilePreviewMessage>正在读取本轮改动…</FilePreviewMessage>
  if (state.status === 'error') return <FilePreviewMessage>{state.message}</FilePreviewMessage>
  const { changes } = state
  const expanded = new Set(page.expandedPaths.map(filePathKey))
  return <div className="wc-changes-panel flex min-h-0 flex-1 flex-col">
    <div className="wc-changes-summary">
      <span className="min-w-0 truncate">已更改 {changes.length} 个文件</span>
      <ChangeCounts {...totalFileChanges(changes)} />
    </div>
    <div ref={ref} onScroll={onScroll} style={{ overscrollBehaviorY }} className="wc-changes-scroll wc-scrollbar min-h-0 flex-1 overflow-y-auto">
      <div>
        {!changes.length && <FilePreviewMessage>没有可展示的文件改动</FilePreviewMessage>}
        {changes.map(change => <ChangedFile key={filePathKey(change.path)} {...props} change={change}
          onReady={page.selectedPath && filePathKey(page.selectedPath) === filePathKey(change.path) ? focusSelected : undefined}
          expanded={expanded.has(filePathKey(change.path))}
          onToggle={() => {
            const open = !expanded.has(filePathKey(change.path))
            onOpenPage({ ...page, selectedPath: null,
              expandedPaths: open ? [...page.expandedPaths, change.path]
                : page.expandedPaths.filter(path => filePathKey(path) !== filePathKey(change.path)) })
          }} />)}
      </div>
    </div>
  </div>
}

function ChangedFile({ runtimeId, projectDir, page, onOpenPage, change, expanded, onToggle, onReady }: Props & {
  change: ToolFileChange; expanded: boolean; onToggle: () => void; onReady?: () => void
}) {
  const id = useId()
  const name = fileName(change.path)
  const Icon = fileIcon(name)
  const action = useWorkspaceFileAction(runtimeId, change.path)
  return <section className="wc-changes-file" data-expanded={expanded} data-change-path={filePathKey(change.path)}>
    <div className="wc-changes-file-heading">
      <button type="button" className="wc-changes-file-trigger wc-focus-ring" onClick={onToggle}
        title={change.path} aria-expanded={expanded} aria-controls={expanded ? id : undefined} aria-label={`查看 ${change.path} 的改动`}>
        <ChevronRight size={13} className="wc-changes-chevron shrink-0" aria-hidden="true" />
        <Icon size={14} className="shrink-0 text-[var(--wc-muted)]" aria-hidden="true" />
        <ChangedFilePath path={change.path} projectDir={projectDir} />
        <ChangeCounts added={change.added} removed={change.removed} />
      </button>
      <div className="wc-changes-file-actions">
        <button type="button" className="wc-preview-action" title="在标签页中打开文件" aria-label={`在标签页中打开 ${name}`}
          onClick={() => onOpenPage({ kind: 'file', path: change.path, name, source: { kind: 'current' }, previewMode: 'code' })}>
          <PanelRightOpen size={14} />
        </button>
        <button type="button" className="wc-preview-action" title="在文件夹中显示" aria-label={`在文件夹中显示 ${name}`}
          disabled={action.pending} aria-busy={action.pending} onClick={() => void action.run('reveal')}>
          <FolderOpen size={14} />
        </button>
      </div>
    </div>
    {expanded && <div id={id} className="wc-changes-file-diff">
      <ChangePreview runtimeId={runtimeId} checkpointIds={page.checkpointIds} path={change.path} onReady={onReady} />
    </div>}
  </section>
}

function ChangePreview({ runtimeId, checkpointIds, path, onReady }: {
  runtimeId: string; checkpointIds: string[]; path: string; onReady?: () => void
}) {
  const state = useCheckpointFilePreview(runtimeId, checkpointIds, path)
  useLayoutEffect(() => { if (state.status === 'ready') onReady?.() }, [state.status, onReady])
  if (state.status === 'loading') return <FilePreviewMessage>正在读取差异…</FilePreviewMessage>
  if (state.status === 'error') return <FilePreviewMessage>{state.message}</FilePreviewMessage>
  return <FileDiff path={path} preview={state.preview} />
}
