import { useCallback, useLayoutEffect } from 'react'
import type { RightPanelPage } from './right-panel-state.ts'
import { useResponseFileChanges, totalFileChanges } from './response-file-changes-data.ts'
import { ChangeCounts } from './file-change-summary.tsx'
import { ChangedFile } from './changed-file.tsx'
import { FileDiff } from './file-diff.tsx'
import { FilePreviewMessage } from './file-preview-controls.tsx'
import { useCheckpointFilePreview } from './file-preview-data.ts'
import { filePathKey } from './local-files.ts'
import { useScrollArea } from './use-scroll-area.ts'

type ChangesPage = Extract<RightPanelPage, { kind: 'changes' }>
interface Props {
  remote?: boolean
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
          expanded={expanded.has(filePathKey(change.path))}
          onToggle={() => {
            const open = !expanded.has(filePathKey(change.path))
            onOpenPage({ ...page, selectedPath: null,
              expandedPaths: open ? [...page.expandedPaths, change.path]
                : page.expandedPaths.filter(path => filePathKey(path) !== filePathKey(change.path)) })
          }}><ChangePreview runtimeId={runtimeId} checkpointIds={page.checkpointIds} path={change.path}
            onReady={page.selectedPath && filePathKey(page.selectedPath) === filePathKey(change.path) ? focusSelected : undefined} />
        </ChangedFile>)}
      </div>
    </div>
  </div>
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
