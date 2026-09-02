import type { SkillSummary } from '@whycode/core/skills'
import { Check, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  restoreConfirmationActions,
  type CheckpointRestoreRequest,
  type CheckpointRestoreScope,
} from './checkpoint-restore-controls.ts'
import type { Block } from './conversation-state.ts'
import { CandidateCard, PeerCard } from './consensus-blocks.tsx'
import { UserImageGallery } from './image-attachments.tsx'
import { formatFinishedWorkTime } from './processing-time.ts'
import { UserMessageCard } from './user-message-card.tsx'
import { MessageActions } from './message-actions.tsx'
import { MarkdownContent } from './markdown-content.tsx'
import { FadedScrollArea } from './faded-scroll-area.tsx'
import { StreamingPlainText } from './streaming-plain-text.tsx'
import {
  summarizeToolCallParts,
  toolCallDetails,
} from './tool-call-summary.ts'
import { ConversationTimelineMarker } from './conversation-timeline-marker.tsx'

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
  onCheckpointRestoreRequest,
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
  onCheckpointRestoreRequest: CheckpointRestoreRequest
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
    return (
      <ConversationTimelineMarker tone={block.tone ?? 'neutral'}>
        {block.text}
      </ConversationTimelineMarker>
    )
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
          <div className="mt-1">
            <FadedScrollArea
              className="wc-scrollbar max-h-[min(22rem,42vh)] overflow-y-auto pr-2"
              followEnd={streaming}
            >
              <StreamingPlainText
                text={block.text}
                resetKey={`${runtimeId}:${block.id}`}
                className="whitespace-pre-wrap border-l-2 border-[var(--wc-line)] pb-0.5 pl-3 text-xs leading-5 text-[var(--wc-faint)]"
              />
            </FadedScrollArea>
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
            onRequest={onCheckpointRestoreRequest}
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
  onRequest,
}: {
  runtimeId: string
  toolUseId: string
  busy: boolean
  pending: boolean
  onRequest: CheckpointRestoreRequest
}) {
  const [open, setOpen] = useState(false)
  const [checkingScope, setCheckingScope] = useState<CheckpointRestoreScope | null>(null)
  const [confirmScope, setConfirmScope] = useState<CheckpointRestoreScope | null>(null)
  const pendingRef = useRef(false)
  const requestVersionRef = useRef(0)

  useEffect(() => {
    requestVersionRef.current++
    pendingRef.current = false
    setOpen(false)
    setCheckingScope(null)
    setConfirmScope(null)
  }, [runtimeId, toolUseId])

  useEffect(() => {
    if (!busy || pending) return
    requestVersionRef.current++
    pendingRef.current = false
    setOpen(false)
    setCheckingScope(null)
    setConfirmScope(null)
  }, [busy, pending])

  const check = async (scope: CheckpointRestoreScope) => {
    if (pendingRef.current || busy) return
    pendingRef.current = true
    const requestVersion = ++requestVersionRef.current
    setCheckingScope(scope)
    try {
      const allowed = await onRequest(toolUseId, scope, 'check')
      if (requestVersionRef.current === requestVersion && allowed) setConfirmScope(scope)
    } finally {
      if (requestVersionRef.current === requestVersion) {
        pendingRef.current = false
        setCheckingScope(null)
      }
    }
  }

  const restore = async () => {
    if (!confirmScope || pendingRef.current || busy) return
    pendingRef.current = true
    const scope = confirmScope
    setOpen(false)
    setConfirmScope(null)
    try {
      await onRequest(toolUseId, scope, 'restore')
    } finally {
      pendingRef.current = false
    }
  }

  if (pending) {
    return (
      <button
        className="flex shrink-0 cursor-wait items-center gap-1 text-xs text-[var(--wc-faint)]"
        disabled
        aria-busy="true"
      >
        <LoaderCircle size={12} className="animate-spin" /> 正在回滚…
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
  if (confirmScope) {
    const actions = restoreConfirmationActions(confirmScope)
    const scopeLabel = confirmScope === 'files' ? '仅文件' : '文件与对话'
    return (
      <span className="flex shrink-0 gap-1 text-xs">
        {actions.map((item, index) => (
          <button
            key={`${item.action}-${index}`}
            className={`wc-focus-ring inline-flex justify-center rounded-lg border px-2 py-0.5 ${index === 0 ? 'w-16' : 'w-20'} ${item.action === 'confirm'
              ? 'border-[#dec8bf] text-[var(--wc-danger)] hover:bg-[#f8efec]'
              : 'border-[var(--wc-line)] hover:border-[var(--wc-line-strong)]'
            }`}
            disabled={busy}
            aria-label={item.action === 'confirm' ? `确认回滚${scopeLabel}` : `取消回滚${scopeLabel}`}
            title={item.action === 'confirm' ? `确认回滚${scopeLabel}` : `取消回滚${scopeLabel}`}
            onClick={() => {
              if (item.action === 'confirm') {
                void restore()
              } else {
                setOpen(false)
                setConfirmScope(null)
              }
            }}
          >
            {item.label}
          </button>
        ))}
        <span aria-hidden="true" className="w-5 shrink-0" />
      </span>
    )
  }
  return (
    <span className="flex shrink-0 gap-1 text-xs">
      <button
        className="wc-focus-ring inline-flex w-16 items-center justify-center gap-1 rounded-lg border border-[var(--wc-line)] px-2 py-0.5"
        disabled={busy || checkingScope !== null}
        onClick={() => void check('files')}
      >
        {checkingScope === 'files' ? (
          <><LoaderCircle size={11} className="animate-spin" /> 校验</>
        ) : '仅文件'}
      </button>
      <button
        className="wc-focus-ring inline-flex w-20 items-center justify-center gap-1 rounded-lg border border-[var(--wc-line)] px-2 py-0.5"
        disabled={busy || checkingScope !== null}
        onClick={() => void check('files-and-chat')}
      >
        {checkingScope === 'files-and-chat' ? (
          <><LoaderCircle size={11} className="animate-spin" /> 校验</>
        ) : '文件+对话'}
      </button>
      <button
        className="wc-focus-ring flex w-5 shrink-0 items-center justify-center rounded text-[var(--wc-faint)]"
        disabled={checkingScope !== null}
        onClick={() => setOpen(false)}
        aria-label="关闭回滚选项"
      >
        <X size={12} />
      </button>
    </span>
  )
}
