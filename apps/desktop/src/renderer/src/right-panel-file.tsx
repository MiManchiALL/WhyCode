import { FileSearch } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import type { CheckpointFilePreview } from '@whycode/core'
import type { RightPanelPage } from './right-panel-state.ts'
import { DocumentPreview } from './document-preview.tsx'
import { FilePreviewMessage, FilePreviewToolbar, FileWrapButton } from './file-preview-controls.tsx'
import { useCheckpointFileCurrentMatch, useCheckpointFilePreview } from './file-preview-data.ts'
import { contentLines, firstChangedLine, previewTextState } from './file-change-presentation.ts'
import { SyntaxCode } from './syntax-code.tsx'

type FilePage = Extract<RightPanelPage, { kind: 'file' }>
type SnapshotPage = FilePage & { source: Extract<FilePage['source'], { kind: 'snapshot' }> }
interface FileProps {
  runtimeId: string
  refreshRevision: string
  page: FilePage
  onChange: (page: FilePage) => void
  onReferenceInBrowser?: (path: string) => void
}

export function RightPanelFilePreview(props: FileProps) {
  return props.page.source.kind === 'current'
    ? <DocumentPreview {...props} />
    : <SnapshotFile {...props} page={{ ...props.page, source: props.page.source }} />
}

function SnapshotFile({ runtimeId, refreshRevision, page, onChange }: Omit<FileProps, 'page'> & { page: SnapshotPage }) {
  const match = useCheckpointFileCurrentMatch(runtimeId, page.source.toolUseId, page.path, refreshRevision)
  const current = match.status === 'ready' && match.matches
  useEffect(() => {
    if (current) onChange({ ...page, source: { kind: 'current' } })
  }, [current, onChange, page])
  if (current || match.status === 'loading') return <FilePreviewMessage>正在读取文件…</FilePreviewMessage>
  return <FileSnapshot runtimeId={runtimeId} page={page} onChange={onChange} />
}

function FileSnapshot({ runtimeId, page, onChange }: Omit<FileProps, 'page' | 'refreshRevision'> & { page: SnapshotPage }) {
  const state = useCheckpointFilePreview(runtimeId, page.source.toolUseId, page.path)
  const wrap = page.wrap ?? false
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilePreviewToolbar path={page.path}>
        <button type="button" className="wc-preview-action" title="打开当前文件" aria-label="打开当前文件"
          onClick={() => onChange({ ...page, source: { kind: 'current' } })}>
          <FileSearch size={15} />
        </button>
        <FileWrapButton wrap={wrap} onChange={wrap => onChange({ ...page, wrap })} />
        <span className="shrink-0 whitespace-nowrap rounded-md bg-black/[0.045] px-1.5 py-0.5 text-[var(--wc-faint)]">操作后快照</span>
      </FilePreviewToolbar>
      {state.status === 'loading' ? <FilePreviewMessage>正在读取文件快照…</FilePreviewMessage>
        : state.status === 'error' ? <FilePreviewMessage>{state.message}</FilePreviewMessage>
        : <SnapshotCode page={page} preview={state.preview} wrap={wrap} />}
    </div>
  )
}

function SnapshotCode({ page, preview, wrap }: { page: SnapshotPage; preview: CheckpointFilePreview; wrap: boolean }) {
  const before = previewTextState(preview.before)
  const after = previewTextState(preview.after)
  const beforeContent = before.ok ? before.content : null
  const afterContent = after.ok ? after.content : null
  const lines = useMemo(() => contentLines(afterContent ?? ''), [afterContent])
  const location = useMemo(() => {
    if (page.source.toolName !== 'EditFile' || beforeContent === null || afterContent === null) return undefined
    const line = firstChangedLine(beforeContent, afterContent)
    return line === null ? undefined : { line }
  }, [page.source.toolName, beforeContent, afterContent])
  if (!after.ok) return <FilePreviewMessage>{after.message}</FilePreviewMessage>
  return <SyntaxCode path={page.path} lines={lines} location={location} wrap={wrap} className="flex-1" />
}
