import type { SkillSummary } from '@whycode/core/skills'
import {
  ChevronRight,
  FilePenLine,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { RestoreButton } from './conversation-block.tsx'
import type { ToolCall } from './conversation-state.ts'
import {
  summarizeToolBatch,
  toolBatchRows,
  toolCategory,
  type ToolBatch,
  type ToolBatchCategory,
  type ToolBatchRow,
} from './conversation-tool-batches.ts'
import { UserImageGallery } from './image-attachments.tsx'
import { CopyButton } from './message-actions.tsx'
import { toolCallDetails } from './tool-call-summary.ts'

export function ToolBatchGroup({
  runtimeId,
  batch,
  expandedIds,
  busy,
  checkpointRestoreAnchorIds,
  checkpointRestoreToolUseId,
  skills,
  projectDir,
  onCheckpointRestoreChange,
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
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
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
              onCheckpointRestoreChange={onCheckpointRestoreChange}
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
  onCheckpointRestoreChange,
  onToggle,
}: {
  runtimeId: string
  row: ToolBatchRow
  expanded: boolean
  busy: boolean
  checkpointRestorePending: boolean
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onToggle: () => void
}) {
  const failed = row.call.status === 'error'
  return (
    <div className="wc-tool-batch-item" data-error={failed ? 'true' : 'false'}>
      <div className="flex min-w-0 items-center gap-1">
        <button
          type="button"
          className="wc-focus-ring wc-tool-batch-row group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <BatchIcon category={toolCategory(row.call.name)} size={13} />
          <span className="shrink-0">{row.call.name}</span>
          {row.summary ? row.fullPath ? (
            <FilePathLabel name={row.summary} path={row.fullPath} />
          ) : (
            <span className="min-w-0 truncate">{row.summary}</span>
          ) : null}
          {row.added !== undefined && row.removed !== undefined ? (
            <span className="flex shrink-0 gap-1.5 tabular-nums">
              <span className="wc-tool-lines-added">+{row.added}</span>
              <span className="wc-tool-lines-removed">-{row.removed}</span>
            </span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            size={13}
            className={`wc-tool-batch-chevron ml-auto shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
        {row.checkpointAnchor && row.call.status !== 'running' ? (
          <RestoreButton
            runtimeId={runtimeId}
            toolUseId={row.call.id}
            busy={busy}
            pending={checkpointRestorePending}
            onPendingChange={onCheckpointRestoreChange}
          />
        ) : null}
      </div>
      {expanded ? <ToolBatchRowDetails call={row.call} /> : null}
    </div>
  )
}

function ToolBatchRowDetails({ call }: { call: ToolCall }) {
  const customDetails = toolCallDetails(
    call.name,
    call.input,
    call.result,
    call.status === 'error',
  )
  const details = customDetails ?? call.result ?? call.progress
  if (call.name === 'RunCommand') {
    return <RunCommandDetails command={runCommand(call.input)} output={details} />
  }
  if (!details && !call.attachments?.length) return null
  return (
    <div className="wc-tool-batch-details ml-1 mt-0.5 mb-1.5 overflow-hidden rounded-xl">
      {call.attachments?.length ? (
        <div className="border-b border-[var(--wc-line)] px-3 pt-2">
          <UserImageGallery attachments={call.attachments} variant="tool" />
        </div>
      ) : null}
      {details ? (
        <FadedScrollArea className="wc-scrollbar max-h-44 overflow-y-auto">
          <pre className="whitespace-pre-wrap break-words px-3 py-2 text-xs leading-5">{details}</pre>
        </FadedScrollArea>
      ) : null}
    </div>
  )
}

function RunCommandDetails({ command, output }: { command: string; output: string }) {
  return (
    <div className="wc-tool-batch-details ml-1 mt-0.5 mb-1.5 overflow-hidden rounded-xl">
      <div className="wc-tool-copy-scope relative border-b border-[var(--wc-line)] px-3 py-2 pr-9">
        <div className="mb-1 text-xs text-[var(--wc-faint)]">Shell</div>
        <pre className="whitespace-pre-wrap break-words text-xs leading-5">$ {command}</pre>
        <CopyButton
          text={command}
          label="复制完整命令"
          ariaLabel="复制完整命令"
          className="wc-tool-copy-button absolute top-2 right-2 text-[var(--wc-faint)]"
        />
      </div>
      {output ? (
        <div className="wc-tool-copy-scope relative">
          <FadedScrollArea className="wc-scrollbar max-h-44 overflow-y-auto overscroll-contain">
            <pre className="whitespace-pre-wrap break-words px-3 py-2 pr-9 text-xs leading-5">{output}</pre>
          </FadedScrollArea>
          <CopyButton
            text={output}
            label="复制命令输出"
            ariaLabel="复制命令输出"
            className="wc-tool-copy-button absolute top-2 right-2 text-[var(--wc-faint)]"
          />
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

function FilePathLabel({ name, path }: { name: string; path: string }) {
  const labelRef = useRef<HTMLSpanElement>(null)
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
      <span
        ref={labelRef}
        className="wc-tool-file-name min-w-0 truncate"
        aria-label={path}
        onMouseEnter={show}
        onMouseLeave={() => setTooltip(null)}
        onFocus={show}
        onBlur={() => setTooltip(null)}
      >
        {name}
      </span>
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

function FadedScrollArea({
  id,
  className,
  children,
}: {
  id?: string
  className: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [fades, setFades] = useState({ top: false, bottom: false })
  const update = useCallback(() => {
    const element = ref.current
    if (!element) return
    const next = {
      top: element.scrollTop > 1,
      bottom: element.scrollTop + element.clientHeight < element.scrollHeight - 1,
    }
    setFades((previous) => previous.top === next.top && previous.bottom === next.bottom
      ? previous
      : next)
  }, [])
  useLayoutEffect(() => {
    update()
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)
    return () => observer.disconnect()
  })
  return (
    <div
      className="wc-scroll-fade relative"
      data-fade-top={fades.top ? 'true' : 'false'}
      data-fade-bottom={fades.bottom ? 'true' : 'false'}
    >
      <div ref={ref} id={id} className={className} onScroll={update}>{children}</div>
      <span aria-hidden="true" className="wc-scroll-fade-top" />
      <span aria-hidden="true" className="wc-scroll-fade-bottom" />
    </div>
  )
}

function runCommand(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const command = (input as Record<string, unknown>).command
  return typeof command === 'string' ? command : ''
}
