import type { SkillSummary } from '@whycode/core/skills'
import { Check, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useRef, useState } from 'react'
import type { Block } from './conversation-state.ts'
import { CandidateCard, PeerCard } from './consensus-blocks.tsx'
import { UserImageGallery } from './image-attachments.tsx'
import { formatFinishedWorkTime } from './processing-time.ts'
import { UserMessageCard } from './user-message-card.tsx'
import { MessageActions } from './message-actions.tsx'
import { MarkdownContent } from './markdown-content.tsx'
import {
  summarizeToolCallParts,
  toolCallDetails,
} from './tool-call-summary.ts'

export function BlockView({
  runtimeId,
  block,
  editable,
  expanded,
  busy,
  showCheckpointRestore,
  checkpointRestorePending,
  streamingAssistantText,
  renderMath,
  onCheckpointRestoreChange,
  onEdit,
  onToggle,
  showAssistantActions,
  forkTurnId,
  forkPending,
  onFork,
  skills,
  projectDir,
}: {
  runtimeId: string
  block: Block
  editable: boolean
  expanded: boolean
  busy: boolean
  showCheckpointRestore: boolean
  checkpointRestorePending: boolean
  streamingAssistantText: boolean
  renderMath: boolean
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onEdit: (block: Extract<Block, { kind: 'user' }>, text: string) => Promise<boolean>
  onToggle: () => void
  showAssistantActions: boolean
  forkTurnId: string | null
  forkPending: boolean
  onFork: (turnId: string) => void
  skills: readonly SkillSummary[]
  projectDir: string | null
}) {
  if (block.kind === 'user') {
    return (
      <UserMessageCard
        runtimeId={runtimeId}
        block={block}
        editable={editable}
        disabled={busy}
        onEdit={onEdit}
      />
    )
  }
  if (block.kind === 'text') {
    return (
      <div
        className={`group max-w-none px-1 py-1 ${showAssistantActions ? 'mb-2' : 'mb-4'}`}
        data-conversation-scroll-block={block.id}
      >
        <div className="wc-conversation-copy max-w-none">
          <MarkdownContent
            text={block.text}
            streaming={streamingAssistantText}
            renderMath={renderMath}
          />
        </div>
        {showAssistantActions ? (
          <MessageActions
            timestamp={block.timestamp}
            text={block.text}
            className="mt-1"
            onFork={forkTurnId && !busy ? () => onFork(forkTurnId) : undefined}
            forkPending={forkPending}
          />
        ) : null}
      </div>
    )
  }
  if (block.kind === 'error') {
    return <div className="wc-menu-surface mb-3 border-[#dec8bf] bg-[#f8efec] px-3 py-2 wc-type-control text-[var(--wc-danger)]">{block.text}</div>
  }
  if (block.kind === 'notice') {
    return <div className="mb-3 rounded-xl bg-[var(--wc-blue)] px-3 py-2 text-xs text-[var(--wc-blue-ink)]">{block.text}</div>
  }
  if (block.kind === 'peer') {
    return <PeerCard peer={block.peer} expanded={expanded} onToggle={onToggle} />
  }
  if (block.kind === 'candidate') {
    return <CandidateCard candidate={block.candidate} expanded={expanded} onToggle={onToggle} />
  }
  if (block.kind === 'thinking') {
    const streaming = block.durationMs === null
    const open = streaming || expanded
    return (
      <div className="mb-3 px-1">
        <button
          className="wc-focus-ring rounded-lg px-1 py-0.5 text-xs text-[var(--wc-faint)] hover:text-[var(--wc-muted)]"
          onClick={() => !streaming && onToggle()}
        >
          {streaming ? '思考中…' : `思考了 ${(block.durationMs! / 1000).toFixed(1)}s ${open ? '▾' : '▸'}`}
        </button>
        {open && (
          <div className="mt-1 whitespace-pre-wrap border-l-2 border-[var(--wc-line)] pl-3 text-xs leading-5 text-[var(--wc-faint)]">
            {block.text}
          </div>
        )}
      </div>
    )
  }
  if (block.kind === 'work-duration') {
    return (
      <div className="mb-3 px-1 text-xs text-[var(--wc-faint)]">
        {formatFinishedWorkTime(block.durationMs, block.outcome)}
      </div>
    )
  }

  const { call } = block
  const icon = call.status === 'running'
    ? <LoaderCircle size={14} className="animate-spin" />
    : call.status === 'error'
      ? <X size={14} />
      : <Check size={14} />
  const summary = summarizeToolCallParts(call.name, call.input, {
    result: call.result,
    skills,
    projectDir,
  })
  const customDetails = toolCallDetails(
    call.name,
    call.input,
    call.result,
    call.status === 'error',
  )
  const details = customDetails ?? call.result ?? call.progress
  return (
    <div className="wc-menu-surface mb-3 overflow-hidden wc-type-control">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle}>
          <span className={call.status === 'error' ? 'text-[var(--wc-danger)]' : 'text-[var(--wc-muted)]'}>{icon}</span>
          <span className="shrink-0 font-medium">{call.name}</span>
          {summary.primary && (
            <span className="min-w-0 truncate text-xs text-[var(--wc-faint)]">{summary.primary}</span>
          )}
          {summary.trailing && (
            <span className="shrink-0 text-xs text-[var(--wc-faint)]">· {summary.trailing}</span>
          )}
        </button>
        {showCheckpointRestore && call.status !== 'running' && (
          <RestoreButton
            runtimeId={runtimeId}
            toolUseId={call.id}
            busy={busy}
            pending={checkpointRestorePending}
            onPendingChange={onCheckpointRestoreChange}
          />
        )}
      </div>
      {call.attachments?.length ? (
        <div className="border-t border-[var(--wc-line)] px-3 pt-2">
          <UserImageGallery attachments={call.attachments} variant="tool" />
        </div>
      ) : null}
      {expanded && details && (
        <pre className="wc-scrollbar max-h-64 overflow-auto border-t border-[var(--wc-line)] bg-black/[0.018] px-3 py-2 text-xs leading-5 text-[var(--wc-muted)]">
          {details}
        </pre>
      )}
    </div>
  )
}

export function RestoreButton({
  runtimeId,
  toolUseId,
  busy,
  pending,
  onPendingChange,
}: {
  runtimeId: string
  toolUseId: string
  busy: boolean
  pending: boolean
  onPendingChange: (toolUseId: string, pending: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const pendingRef = useRef(false)
  const restore = async (scope: 'files' | 'files-and-chat') => {
    if (pendingRef.current || busy) return
    pendingRef.current = true
    onPendingChange(toolUseId, true)
    setOpen(false)
    try {
      await window.whycode.sendCommand(
        runtimeId,
        { type: 'restore-checkpoint', toolUseId, scope },
      )
    } finally {
      pendingRef.current = false
      onPendingChange(toolUseId, false)
    }
  }
  if (pending) {
    return (
      <button
        className="flex shrink-0 cursor-wait items-center gap-1 text-xs text-[var(--wc-faint)]"
        disabled
        aria-busy="true"
      >
        <LoaderCircle size={12} className="animate-spin" /> 本轮回滚中…
      </button>
    )
  }
  if (!open) {
    return (
      <button
        className="wc-focus-ring flex shrink-0 items-center gap-1 rounded-lg px-1 py-0.5 text-xs text-[var(--wc-faint)] hover:text-[var(--wc-ink)]"
        disabled={busy}
        title="从本轮首个文件改动开始回滚"
        onClick={() => setOpen(true)}
      >
        <RotateCcw size={12} /> 回滚本轮
      </button>
    )
  }
  return (
    <span className="flex shrink-0 gap-1 text-xs">
      <button
        className="wc-focus-ring rounded-lg border border-[var(--wc-line)] px-2 py-0.5"
        disabled={busy}
        onClick={() => void restore('files')}
      >
        仅文件
      </button>
      <button
        className="wc-focus-ring rounded-lg border border-[var(--wc-line)] px-2 py-0.5"
        disabled={busy}
        onClick={() => void restore('files-and-chat')}
      >
        文件+对话
      </button>
      <button className="wc-focus-ring rounded px-1 text-[var(--wc-faint)]" onClick={() => setOpen(false)} aria-label="关闭回滚选项">
        <X size={12} />
      </button>
    </span>
  )
}
