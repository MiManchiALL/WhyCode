import { useRef, useState } from 'react'
import { Streamdown } from 'streamdown'
import type { Block } from './conversation-state.ts'
import { CandidateCard, PeerCard } from './consensus-blocks.tsx'
import { UserImageGallery } from './image-attachments.tsx'
import { formatFinishedWorkTime } from './processing-time.ts'
import { UserMessageCard } from './user-message-card.tsx'

export function BlockView({
  runtimeId,
  block,
  editable,
  expanded,
  busy,
  showCheckpointRestore,
  checkpointRestoreToolUseId,
  onCheckpointRestoreChange,
  onEdit,
  onToggle,
}: {
  runtimeId: string
  block: Block
  editable: boolean
  expanded: boolean
  busy: boolean
  showCheckpointRestore: boolean
  checkpointRestoreToolUseId: string | null
  onCheckpointRestoreChange: (toolUseId: string, pending: boolean) => void
  onEdit: (turnId: string, text: string) => Promise<boolean>
  onToggle: () => void
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
      <div className="prose prose-sm prose-neutral mb-2 max-w-none px-3 py-2">
        <Streamdown>{block.text}</Streamdown>
      </div>
    )
  }
  if (block.kind === 'error') {
    return <div className="mb-2 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{block.text}</div>
  }
  if (block.kind === 'notice') {
    return <div className="mb-2 rounded bg-blue-50 px-3 py-2 text-xs text-blue-700">{block.text}</div>
  }
  if (block.kind === 'plan-replaced') {
    const completed = block.previous.items.filter((item) => item.status === 'completed').length
    return (
      <div className="mb-2 rounded border border-slate-200 bg-slate-50 text-xs text-slate-600">
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
          onClick={onToggle}
        >
          <span>↪</span>
          <span className="min-w-0 flex-1 truncate">
            已归档未完成计划“{block.previous.goal}”（{completed}/{block.previous.items.length}）
          </span>
          <span className="text-slate-400">{expanded ? '▾' : '▸'}</span>
        </button>
        {expanded && (
          <div className="space-y-1 border-t border-slate-200 px-3 py-2">
            <div>替换原因：{block.previous.summary}</div>
            <div>当前计划：{block.nextGoal}</div>
            {block.previous.items.map((item) => (
              <div key={item.id} className="text-slate-400">
                {item.id} [{item.status}] {item.title}
              </div>
            ))}
          </div>
        )}
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
      <div className="mb-2">
        <button
          className="text-xs text-neutral-400 hover:text-neutral-600"
          onClick={() => !streaming && onToggle()}
        >
          {streaming ? '思考中…' : `思考了 ${(block.durationMs! / 1000).toFixed(1)}s ${open ? '▾' : '▸'}`}
        </button>
        {open && (
          <div className="mt-1 whitespace-pre-wrap border-l-2 border-neutral-200 pl-3 text-xs text-neutral-400">
            {block.text}
          </div>
        )}
      </div>
    )
  }
  if (block.kind === 'work-duration') {
    return (
      <div className="mb-2 px-3 text-xs text-neutral-400">
        {formatFinishedWorkTime(block.durationMs, block.outcome)}
      </div>
    )
  }

  const { call } = block
  const icon = call.status === 'running' ? '○' : call.status === 'error' ? '✗' : '✓'
  const summary = summarizeInput(call.input)
  return (
    <div className="mb-2 rounded border border-neutral-200 bg-white text-sm">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle}>
          <span className={call.status === 'error' ? 'text-red-500' : 'text-neutral-500'}>{icon}</span>
          <span className="font-medium">{call.name}</span>
          <span className="truncate text-xs text-neutral-400">{summary}</span>
        </button>
        {showCheckpointRestore && call.status !== 'running' && (
          <RestoreButton
            runtimeId={runtimeId}
            toolUseId={call.id}
            busy={busy}
            pending={checkpointRestoreToolUseId === call.id}
            onPendingChange={onCheckpointRestoreChange}
          />
        )}
      </div>
      {call.attachments?.length ? (
        <div className="border-t border-neutral-100 px-3 pt-2">
          <UserImageGallery attachments={call.attachments} />
        </div>
      ) : null}
      {expanded && (call.result || call.progress) && (
        <pre className="max-h-64 overflow-auto border-t border-neutral-100 px-3 py-2 text-xs text-neutral-600">
          {call.result || call.progress}
        </pre>
      )}
    </div>
  )
}

function RestoreButton({
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
        className="shrink-0 cursor-wait text-xs text-neutral-400"
        disabled
        aria-busy="true"
      >
        ○ 本轮回滚中…
      </button>
    )
  }
  if (!open) {
    return (
      <button
        className="shrink-0 text-xs text-neutral-400 hover:text-neutral-700"
        disabled={busy}
        title="从本轮首个文件改动开始回滚"
        onClick={() => setOpen(true)}
      >
        ⟲ 回滚本轮
      </button>
    )
  }
  return (
    <span className="flex shrink-0 gap-1 text-xs">
      <button
        className="rounded border border-neutral-300 px-2 py-0.5"
        disabled={busy}
        onClick={() => void restore('files')}
      >
        仅文件
      </button>
      <button
        className="rounded border border-neutral-300 px-2 py-0.5"
        disabled={busy}
        onClick={() => void restore('files-and-chat')}
      >
        文件+对话
      </button>
      <button className="px-1 text-neutral-400" onClick={() => setOpen(false)}>
        ✕
      </button>
    </span>
  )
}

export function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>
    if (typeof obj.path === 'string') return obj.path
    if (typeof obj.pattern === 'string') return obj.pattern
    if (typeof obj.command === 'string') return obj.command
  }
  return JSON.stringify(input) ?? ''
}
