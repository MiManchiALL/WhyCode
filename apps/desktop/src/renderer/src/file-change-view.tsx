import type { CheckpointFilePreview, CheckpointFilePreviewState } from '@whycode/core'
import { FileSearch } from 'lucide-react'
import { useMemo } from 'react'
import { CopyButton } from './message-actions.tsx'
import {
  buildFileDiffHunks,
  contentLines,
  firstChangedLine,
} from './file-change-presentation.ts'
import {
  useCheckpointFileCurrentMatch,
  useCheckpointFilePreview,
  useCurrentFilePreview,
} from './file-preview-data.ts'
import type {
  FilePreviewToolName,
  RightPanelFileSource,
  RightPanelPage,
} from './right-panel-state.ts'
import { SyntaxCode } from './syntax-code.tsx'

type FilePage = Extract<RightPanelPage, { kind: 'file' }>
type InlineFilePreviewToolName = Exclude<FilePreviewToolName, 'MoveFile'>

export function InlineFileChange({
  runtimeId,
  toolUseId,
  toolName,
  path,
  name,
  added,
  removed,
}: {
  runtimeId: string
  toolUseId: string
  toolName: InlineFilePreviewToolName
  path: string
  name: string
  added?: number
  removed?: number
}) {
  const state = useCheckpointFilePreview(runtimeId, toolUseId, path)
  const copyText = state.status === 'ready'
    ? previewTextForTool(state.preview, toolName)
    : null
  return (
    <div className="wc-tool-details wc-file-change-detail overflow-hidden rounded-xl">
      <FileChangeHeader
        name={name}
        added={added}
        removed={removed}
        copyText={copyText}
      />
      {state.status === 'loading'
        ? <PreviewMessage>正在读取文件快照…</PreviewMessage>
        : state.status === 'error'
          ? <PreviewMessage>{state.message}</PreviewMessage>
          : (
              <InlinePreviewContent
                toolName={toolName}
                path={path}
                preview={state.preview}
              />
            )}
    </div>
  )
}

export function RightPanelFilePreview({
  runtimeId,
  refreshRevision,
  page,
  onOpenCurrent,
}: {
  runtimeId: string
  refreshRevision: string
  page: FilePage
  onOpenCurrent: () => void
}) {
  const snapshot = page.source.kind === 'snapshot'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="wc-file-preview-toolbar flex min-w-0 shrink-0 items-center gap-2 border-b border-[var(--wc-line)] px-3 py-2 text-xs">
        <div
          className="min-w-0 flex-1 truncate font-mono text-[var(--wc-faint)]"
          title={page.path}
        >
          {page.path}
        </div>
        {page.source.kind === 'snapshot' ? (
            <OpenCurrentFileAction
              runtimeId={runtimeId}
              refreshRevision={refreshRevision}
              path={page.path}
            toolUseId={page.source.toolUseId}
            onOpenCurrent={onOpenCurrent}
          />
        ) : null}
        <span className="shrink-0 whitespace-nowrap rounded-md bg-black/[0.045] px-1.5 py-0.5 text-[var(--wc-faint)]">
          {snapshot ? '操作后快照' : '当前文件'}
        </span>
      </div>
      {page.source.kind === 'current'
        ? (
            <CurrentRightPanelFile
              runtimeId={runtimeId}
              refreshRevision={refreshRevision}
              page={page}
            />
          )
        : page.source.toolName === 'DeleteFile'
        ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-[var(--wc-faint)]">
              无法打开文件
            </div>
          )
        : (
            <AvailableRightPanelFile
              runtimeId={runtimeId}
              page={page}
              source={page.source}
            />
          )}
    </div>
  )
}

function OpenCurrentFileAction({
  runtimeId,
  refreshRevision,
  toolUseId,
  path,
  onOpenCurrent,
}: {
  runtimeId: string
  refreshRevision: string
  toolUseId: string
  path: string
  onOpenCurrent: () => void
}) {
  const match = useCheckpointFileCurrentMatch(
    runtimeId,
    toolUseId,
    path,
    refreshRevision,
  )
  if (match.status !== 'ready' || match.matches) return null
  return (
    <button
      type="button"
      className="wc-open-current-file wc-focus-ring flex shrink-0 items-center justify-center rounded-md px-1.5 py-0.5 text-[var(--wc-muted)] hover:bg-black/[0.045] hover:text-[var(--wc-ink)]"
      onClick={onOpenCurrent}
      title="读取这个路径现在的内容"
    >
      <FileSearch aria-hidden="true" size={13} className="wc-open-current-file-icon hidden" />
      <span className="wc-open-current-file-label whitespace-nowrap">打开当前文件</span>
    </button>
  )
}

function AvailableRightPanelFile({
  runtimeId,
  page,
  source,
}: {
  runtimeId: string
  page: FilePage
  source: Extract<RightPanelFileSource, { kind: 'snapshot' }>
}) {
  const state = useCheckpointFilePreview(runtimeId, source.toolUseId, page.path)
  if (state.status === 'loading') {
    return <PreviewMessage className="flex-1">正在读取文件快照…</PreviewMessage>
  }
  if (state.status === 'error') {
    return <PreviewMessage className="flex-1">{state.message}</PreviewMessage>
  }
  const after = textState(state.preview.after)
  if (!after.ok) return <PreviewMessage className="flex-1">{after.message}</PreviewMessage>
  const before = textState(state.preview.before)
  const beforeContent = before.ok ? before.content : null
  return (
    <RightPanelTextFile
      path={page.path}
      toolName={source.toolName}
      beforeContent={beforeContent}
      afterContent={after.content}
    />
  )
}

function RightPanelTextFile({
  path,
  toolName,
  beforeContent,
  afterContent,
}: {
  path: string
  toolName: FilePreviewToolName
  beforeContent: string | null
  afterContent: string
}) {
  const lines = useMemo(() => contentLines(afterContent), [afterContent])
  const focusLine = useMemo(
    () => toolName === 'EditFile' && beforeContent !== null
      ? firstChangedLine(beforeContent, afterContent)
      : null,
    [afterContent, beforeContent, toolName],
  )
  return (
    <SyntaxCode
      path={path}
      lines={lines}
      focusLine={focusLine}
      className="flex-1"
    />
  )
}

function CurrentRightPanelFile({
  runtimeId,
  refreshRevision,
  page,
}: {
  runtimeId: string
  refreshRevision: string
  page: FilePage
}) {
  const state = useCurrentFilePreview(runtimeId, page.path, refreshRevision)
  if (state.status === 'loading') {
    return <PreviewMessage className="flex-1">正在读取当前文件…</PreviewMessage>
  }
  if (state.status === 'error') {
    return <PreviewMessage className="flex-1">{state.message}</PreviewMessage>
  }
  const current = textState(state.state)
  if (!current.ok) {
    return (
      <PreviewMessage className="flex-1">
        {state.state.kind === 'missing' ? '无法打开文件' : current.message}
      </PreviewMessage>
    )
  }
  return (
    <SyntaxCode
      path={page.path}
      lines={contentLines(current.content)}
      className="flex-1"
    />
  )
}

function InlinePreviewContent({
  toolName,
  path,
  preview,
}: {
  toolName: InlineFilePreviewToolName
  path: string
  preview: CheckpointFilePreview
}) {
  if (toolName === 'WriteFile') {
    const after = textState(preview.after)
    return after.ok
      ? <FullFilePreview path={path} content={after.content} tone="added" />
      : <PreviewMessage>{after.message}</PreviewMessage>
  }
  if (toolName === 'DeleteFile') {
    const before = textState(preview.before)
    return before.ok
      ? <FullFilePreview path={path} content={before.content} tone="removed" />
      : <PreviewMessage>{before.message}</PreviewMessage>
  }
  return <EditDiff path={path} preview={preview} />
}

function FullFilePreview({
  path,
  content,
  tone,
}: {
  path: string
  content: string
  tone: 'added' | 'removed'
}) {
  const lines = useMemo(() => contentLines(content, tone), [content, tone])
  return <SyntaxCode path={path} lines={lines} className="max-h-64" />
}

function EditDiff({ path, preview }: { path: string; preview: CheckpointFilePreview }) {
  const before = textState(preview.before)
  const after = textState(preview.after)
  const beforeContent = before.ok ? before.content : null
  const afterContent = after.ok ? after.content : null
  const hunks = useMemo(
    () => beforeContent !== null && afterContent !== null
      ? buildFileDiffHunks(beforeContent, afterContent)
      : [],
    [afterContent, beforeContent],
  )
  if (!before.ok) return <PreviewMessage>{before.message}</PreviewMessage>
  if (!after.ok) return <PreviewMessage>{after.message}</PreviewMessage>
  if (hunks.length === 0) return <PreviewMessage>没有可展示的文本差异</PreviewMessage>
  return (
    <div className="wc-scrollbar max-h-72 overflow-y-auto overscroll-contain">
      {hunks.map((hunk, index) => (
        <div key={hunk.id}>
          {index > 0 ? <div className="wc-diff-hunk-gap">···</div> : null}
          <SyntaxCode path={path} lines={hunk.lines} scroll={false} />
        </div>
      ))}
    </div>
  )
}

function FileChangeHeader({
  name,
  added,
  removed,
  copyText,
}: {
  name: string
  added?: number
  removed?: number
  copyText: string | null
}) {
  return (
    <div className="wc-tool-copy-scope relative flex min-w-0 items-center gap-2 border-b border-[var(--wc-line)] px-3 py-1.5 pr-9 text-xs">
      <span className="min-w-0 truncate text-[var(--wc-muted)]">{name}</span>
      {added !== undefined && removed !== undefined ? (
        <span className="flex shrink-0 gap-1.5 tabular-nums">
          <span className="wc-tool-lines-added">+{added}</span>
          <span className="wc-tool-lines-removed">-{removed}</span>
        </span>
      ) : null}
      {copyText !== null ? (
        <CopyButton
          text={copyText}
          label="复制文件内容"
          ariaLabel="复制文件内容"
          className="wc-tool-copy-button absolute top-1 right-2 text-[var(--wc-faint)]"
        />
      ) : null}
    </div>
  )
}

function PreviewMessage({
  children,
  className = '',
}: {
  children: string
  className?: string
}) {
  return (
    <div className={`flex items-center justify-center px-4 py-8 text-center text-xs text-[var(--wc-faint)] ${className}`}>
      {children}
    </div>
  )
}

function textState(state: CheckpointFilePreviewState):
  | { ok: true; content: string }
  | { ok: false; message: string } {
  if (state.kind === 'text') return { ok: true, content: state.content }
  if (state.kind === 'missing') return { ok: false, message: '该版本中不存在此文件' }
  return {
    ok: false,
    message: state.reason === 'binary'
      ? '二进制文件不提供文本预览'
      : `文件过大（${formatBytes(state.size)}），不提供内嵌预览`,
  }
}

function previewTextForTool(
  preview: CheckpointFilePreview,
  toolName: InlineFilePreviewToolName,
): string | null {
  const state = toolName === 'DeleteFile' ? preview.before : preview.after
  return state.kind === 'text' ? state.content : null
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KB`
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
}
