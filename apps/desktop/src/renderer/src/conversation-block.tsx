import type { SkillSummary } from '@whycode/core/skills'
import { Check, ChevronRight, LoaderCircle, RotateCcw, X } from 'lucide-react'
import type { CheckpointRestoreRequest } from './checkpoint-restore-controls.ts'
import { RestoreButton } from './checkpoint-restore-button.tsx'
import type { Block } from '../../shared/conversation-state.ts'
import { CandidateCard, PeerCard } from './consensus-blocks.tsx'
import { formatFinishedWorkTime } from './processing-time.ts'
import { UserMessageCard } from './user-message-card.tsx'
import { MarkdownContent } from './markdown-content.tsx'
import { FadedScrollArea } from './faded-scroll-area.tsx'
import { StreamingPlainText } from './streaming-plain-text.tsx'
import { summarizeToolCallParts } from '../../shared/tool-call-summary.ts'
import { ToolSummaryParameters } from './tool-summary-parameters.tsx'
import { ToolCallDetails } from './tool-call-details.tsx'

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
  onOpenCompaction,
  onEdit,
  onToggle,
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
  onOpenCompaction?: (index: number) => void
  onEdit: (block: Extract<Block, { kind: 'user' }>, text: string, restoreFiles: boolean) => Promise<boolean>
  onToggle: () => void
  skills: readonly SkillSummary[]
  projectDir: string | null
}) {
  if (block.kind === 'user') {
    return (
      <UserMessageCard
        key={`${runtimeId}:${block.id}`}
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
        className="mb-4 max-w-none px-1 py-1"
        data-conversation-scroll-block={block.id}
      >
        <div className="wc-conversation-copy max-w-none">
          <MarkdownContent
            text={block.text}
            streaming={streamingAssistantText}
            renderMath={renderMath}
          />
        </div>
      </div>
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
          className="wc-focus-ring wc-type-caption rounded-lg px-1 py-0.5 text-[var(--wc-faint)] hover:text-[var(--wc-muted)]"
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
                className="wc-type-caption whitespace-pre-wrap border-l-2 border-[var(--wc-line)] pb-0.5 pl-3 text-[var(--wc-faint)]"
              />
            </FadedScrollArea>
          </div>
        )}
      </div>
    )
  }
  if (block.kind === 'work-duration') {
    return (
      <div className="wc-type-caption mb-3 px-1 text-[var(--wc-faint)]">
        {formatFinishedWorkTime(block.durationMs, block.outcome)}
      </div>
    )
  }
  if (block.kind === 'model-request-retry') {
    return (
      <div className="wc-type-caption mb-3 flex items-start gap-2 px-1 text-[var(--wc-muted)]" role="status">
        <RotateCcw size={14} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
          模型请求重试 {block.retry}/{block.maxRetries} · {block.message}
        </span>
      </div>
    )
  }
  if (block.kind === 'compaction') {
    return (
      <button
        type="button"
        className="wc-compaction-summary wc-focus-ring wc-type-caption mb-4"
        data-conversation-scroll-block={block.id}
        title={`查看第 ${block.index} 次完整压缩的摘要`}
        disabled={!onOpenCompaction}
        onClick={() => onOpenCompaction?.(block.index)}
      >
        <span className="shrink-0 font-semibold">上下文已压缩</span>
        <span aria-hidden="true" className="opacity-55">·</span>
        <span className="min-w-0 flex-1 truncate">
          {Math.round(block.preTokens / 1000)}k → {Math.round(block.postTokens / 1000)}k tokens
        </span>
        {onOpenCompaction && <ChevronRight size={14} className="shrink-0" aria-hidden="true" />}
      </button>
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
  return (
    <div className="wc-tool-card wc-menu-surface mb-2 overflow-hidden">
      <div className="wc-tool-row flex w-full items-center gap-2 px-3 py-1.5">
        <button
          type="button"
          className="wc-tool-summary wc-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-md text-left"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <span className={`shrink-0 ${call.status === 'error' ? 'text-[var(--wc-danger)]' : 'text-[var(--wc-muted)]'}`}>{icon}</span>
          <span className="max-w-[40%] shrink-0 truncate font-medium">{call.name}</span>
          {summary.parts.length > 0 && (
            <ToolSummaryParameters summary={summary} className="wc-tool-card-description text-[var(--wc-faint)]" />
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
      {expanded ? (
        <div className="px-2 pb-2">
          <ToolCallDetails runtimeId={runtimeId} call={call} projectDir={projectDir} />
        </div>
      ) : null}
    </div>
  )
}
