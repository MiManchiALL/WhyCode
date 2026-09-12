import type { SkillSummary } from '@whycode/core/skills'
import {
  ChevronRight,
  FilePenLine,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { RestoreButton } from './conversation-block.tsx'
import type { CheckpointRestoreRequest } from './checkpoint-restore-controls.ts'
import {
  summarizeToolBatch,
  toolBatchRows,
  toolCategory,
  type ToolBatch,
  type ToolBatchCategory,
  type ToolBatchRow,
} from './conversation-tool-batches.ts'
import { FadedScrollArea } from './faded-scroll-area.tsx'
import {
  isFilePreviewToolName,
  type RightPanelPage,
} from './right-panel-state.ts'
import { ToolCallDetails } from './tool-call-details.tsx'

export function ToolBatchGroup({
  runtimeId,
  batch,
  expandedIds,
  busy,
  checkpointRestoreAnchorIds,
  checkpointRestoreToolUseId,
  skills,
  projectDir,
  onCheckpointRestoreRequest,
  onOpenFilePreview,
  onToggle,
}: {
  runtimeId: string
  batch: ToolBatch
  expandedIds: ReadonlySet<string>
  busy: boolean
  checkpointRestoreAnchorIds: ReadonlySet<string>
  checkpointRestoreToolUseId: string | null
  skills: readonly SkillSummary[]
  projectDir: string | null
  onCheckpointRestoreRequest: CheckpointRestoreRequest
  onOpenFilePreview?: (page: Extract<RightPanelPage, { kind: 'file' }>) => void
  onToggle: (id: string) => void
}) {
  const expanded = expandedIds.has(batch.id)
  const summary = summarizeToolBatch(batch)
  const rows = toolBatchRows(batch, { skills, projectDir, checkpointRestoreAnchorIds })
  return (
    <div className="mb-4 px-1" data-tool-batch={batch.id}>
      <button
        type="button"
        className="wc-focus-ring wc-tool-batch-summary group flex max-w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left"
        aria-expanded={expanded}
        aria-controls={`${batch.id}-content`}
        onClick={() => onToggle(batch.id)}
      >
        <BatchIcon category={summary.icon} size={14} />
        <span className="truncate">{summary.label}</span>
        <ChevronRight
          aria-hidden="true"
          size={14}
          className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded ? (
        <FadedScrollArea
          id={`${batch.id}-content`}
          className="wc-tool-batch-list wc-scrollbar mt-1 max-h-72 overflow-y-auto pr-2"
        >
          {rows.map((row) => (
            <ToolBatchRowView
              key={row.id}
              runtimeId={runtimeId}
              row={row}
              expanded={expandedIds.has(row.id)}
              busy={busy}
              checkpointRestorePending={checkpointRestoreToolUseId === row.call.id}
              onCheckpointRestoreRequest={onCheckpointRestoreRequest}
              onOpenFilePreview={onOpenFilePreview}
              onToggle={() => onToggle(row.id)}
            />
          ))}
        </FadedScrollArea>
      ) : null}
    </div>
  )
}

function ToolBatchRowView({
  runtimeId,
  row,
  expanded,
  busy,
  checkpointRestorePending,
  onCheckpointRestoreRequest,
  onOpenFilePreview,
  onToggle,
}: {
  runtimeId: string
  row: ToolBatchRow
  expanded: boolean
  busy: boolean
  checkpointRestorePending: boolean
  onCheckpointRestoreRequest: CheckpointRestoreRequest
  onOpenFilePreview?: (page: Extract<RightPanelPage, { kind: 'file' }>) => void
  onToggle: () => void
}) {
  const failed = row.call.status === 'error'
  const filePreviewPage = row.call.status === 'done'
    && row.call.createdFileCheckpoint
    && row.fullPath
    && isFilePreviewToolName(row.call.name)
    ? {
        kind: 'file' as const,
        path: row.fullPath,
        name: row.summary,
        source: {
          kind: 'snapshot' as const,
          toolUseId: row.call.id,
          toolName: row.call.name,
        },
      }
    : null
  return (
    <div className="wc-tool-batch-item" data-error={failed ? 'true' : 'false'}>
      <div className="flex min-w-0 items-center gap-1">
        <div
          className="wc-tool-batch-row group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left"
          onClick={onToggle}
        >
          <button
            type="button"
            className="wc-focus-ring flex shrink-0 items-center gap-2 rounded-md text-left"
            aria-expanded={expanded}
          >
            <BatchIcon category={toolCategory(row.call)} size={13} />
            <span>{row.call.name}</span>
          </button>
          {row.renameFrom ? (
            <span className="min-w-0 truncate text-[var(--wc-faint)]">
              {row.renameFrom} →
            </span>
          ) : null}
          {row.summary ? row.fullPath ? (
            <FilePathButton
              name={row.summary}
              path={row.fullPath}
              onOpen={onOpenFilePreview && filePreviewPage
                ? () => onOpenFilePreview(filePreviewPage)
                : undefined}
            />
          ) : (
            <button
              type="button"
              className="wc-focus-ring min-w-0 flex-1 truncate rounded-md text-left"
              aria-expanded={expanded}
            >
              {row.summary}
            </button>
          ) : null}
          {row.added !== undefined && row.removed !== undefined ? (
            <button
              type="button"
              className="wc-focus-ring flex shrink-0 gap-1.5 rounded-md tabular-nums"
              aria-expanded={expanded}
            >
              <span className="wc-tool-lines-added">+{row.added}</span>
              <span className="wc-tool-lines-removed">-{row.removed}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="wc-focus-ring ml-auto flex shrink-0 items-center rounded-md"
            aria-expanded={expanded}
          >
            <ChevronRight
              aria-hidden="true"
              size={13}
              className={`wc-tool-batch-chevron shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </button>
        </div>
        {row.checkpointAnchor && row.call.status !== 'running' ? (
          <RestoreButton
            runtimeId={runtimeId}
            toolUseId={row.call.id}
            busy={busy}
            pending={checkpointRestorePending}
            onRequest={onCheckpointRestoreRequest}
          />
        ) : null}
      </div>
      {expanded ? (
        <div className="ml-1 mt-0.5 mb-1.5">
          <ToolCallDetails runtimeId={runtimeId} call={row.call} file={row} />
        </div>
      ) : null}
    </div>
  )
}

function BatchIcon({ category, size }: { category: ToolBatchCategory; size: number }) {
  if (category === 'files') return <FilePenLine aria-hidden="true" size={size} className="shrink-0" />
  if (category === 'command') return <SquareTerminal aria-hidden="true" size={size} className="shrink-0" />
  return <Wrench aria-hidden="true" size={size} className="shrink-0" />
}

function FilePathButton({
  name,
  path,
  onOpen,
}: {
  name: string
  path: string
  onOpen?: () => void
}) {
  const labelRef = useRef<HTMLButtonElement>(null)
  const [tooltip, setTooltip] = useState<{
    left: number
    top: number
    above: boolean
  } | null>(null)

  const show = () => {
    const label = labelRef.current
    if (!label) return
    const bounds = label.getBoundingClientRect()
    const width = Math.min(448, window.innerWidth - 24)
    setTooltip({
      left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)),
      top: bounds.top > 72 ? bounds.top - 8 : bounds.bottom + 8,
      above: bounds.top > 72,
    })
  }

  useEffect(() => {
    if (!tooltip) return
    const hide = () => setTooltip(null)
    window.addEventListener('resize', hide)
    window.addEventListener('scroll', hide, true)
    return () => {
      window.removeEventListener('resize', hide)
      window.removeEventListener('scroll', hide, true)
    }
  }, [tooltip])

  return (
    <>
      <button
        type="button"
        ref={labelRef}
        className="wc-tool-file-name wc-focus-ring min-w-0 truncate rounded-md text-left"
        aria-label={path}
        onClick={(event) => {
          if (!onOpen) return
          event.stopPropagation()
          onOpen()
        }}
        onMouseEnter={show}
        onMouseLeave={() => setTooltip(null)}
        onFocus={show}
        onBlur={() => setTooltip(null)}
      >
        {name}
      </button>
      {tooltip ? createPortal(
        <span
          role="tooltip"
          className="wc-tool-file-path-tooltip"
          style={{
            left: tooltip.left,
            top: tooltip.top,
            transform: tooltip.above ? 'translateY(-100%)' : undefined,
          }}
        >
          {path}
        </span>,
        document.body,
      ) : null}
    </>
  )
}
