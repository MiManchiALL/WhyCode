import type { CheckpointFilePreview } from '@whycode/core'
import { useMemo, useState } from 'react'
import { FilePreviewMessage as PreviewMessage, FileWrapButton } from './file-preview-controls.tsx'
import { CopyButton } from './message-actions.tsx'
import {
  buildFileDiffHunks,
  contentLines,
  previewTextState,
} from './file-change-presentation.ts'
import { useCheckpointFilePreview } from './file-preview-data.ts'
import type { FilePreviewToolName } from './right-panel-state.ts'
import { SyntaxCode } from './syntax-code.tsx'
import { useScrollArea } from './use-scroll-area.ts'

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
  const [wrap, setWrap] = useState(true)
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
        wrap={wrap}
        onWrapChange={setWrap}
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
                wrap={wrap}
              />
            )}
    </div>
  )
}

function InlinePreviewContent({
  toolName,
  path,
  preview,
  wrap,
}: {
  wrap: boolean
  toolName: InlineFilePreviewToolName
  path: string
  preview: CheckpointFilePreview
}) {
  if (toolName === 'WriteFile') {
    const after = previewTextState(preview.after)
    return after.ok
      ? <FullFilePreview path={path} content={after.content} tone="added" wrap={wrap} />
      : <PreviewMessage>{after.message}</PreviewMessage>
  }
  if (toolName === 'DeleteFile') {
    const before = previewTextState(preview.before)
    return before.ok
      ? <FullFilePreview path={path} content={before.content} tone="removed" wrap={wrap} />
      : <PreviewMessage>{before.message}</PreviewMessage>
  }
  return <EditDiff path={path} preview={preview} wrap={wrap} />
}

function FullFilePreview({
  path,
  content,
  tone,
  wrap,
}: {
  wrap: boolean
  path: string
  content: string
  tone: 'added' | 'removed'
}) {
  const lines = useMemo(() => contentLines(content, tone), [content, tone])
  return <SyntaxCode path={path} lines={lines} wrap={wrap} className="max-h-64" />
}

function EditDiff({ path, preview, wrap }: { path: string; preview: CheckpointFilePreview; wrap: boolean }) {
  const before = previewTextState(preview.before)
  const after = previewTextState(preview.after)
  const beforeContent = before.ok ? before.content : null
  const afterContent = after.ok ? after.content : null
  const hunks = useMemo(
    () => beforeContent !== null && afterContent !== null
      ? buildFileDiffHunks(beforeContent, afterContent)
      : [],
    [afterContent, beforeContent],
  )
  const { ref, onScroll, overscrollBehaviorY } = useScrollArea(hunks, { enabled: hunks.length > 0 })
  if (!before.ok) return <PreviewMessage>{before.message}</PreviewMessage>
  if (!after.ok) return <PreviewMessage>{after.message}</PreviewMessage>
  if (hunks.length === 0) return <PreviewMessage>没有可展示的文本差异</PreviewMessage>
  return (
    <div ref={ref} onScroll={onScroll} style={{ overscrollBehaviorY }} className="wc-scrollbar max-h-72 overflow-y-auto">
      {hunks.map((hunk, index) => (
        <div key={hunk.id}>
          {index > 0 ? <div className="wc-diff-hunk-gap">···</div> : null}
          <SyntaxCode path={path} lines={hunk.lines} scroll={false} wrap={wrap} />
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
  wrap,
  onWrapChange,
}: {
  wrap: boolean
  onWrapChange: (wrap: boolean) => void
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
      <FileWrapButton wrap={wrap} onChange={onWrapChange} />
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

function previewTextForTool(
  preview: CheckpointFilePreview,
  toolName: InlineFilePreviewToolName,
): string | null {
  const state = toolName === 'DeleteFile' ? preview.before : preview.after
  return state.kind === 'text' ? state.content : null
}
