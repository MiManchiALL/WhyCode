import type { QueuedUserMessage } from '@whycode/core/events'
import { LoaderCircle, Pencil, SendHorizontal, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { QueuedImageStrip } from './image-attachments.tsx'
import { QueuedPdfStrip } from './pdf-attachments.tsx'
import { SkillBadges } from './skill-picker.tsx'

export type QueuedMessageAction = 'edit' | 'discard' | 'send-now'

export function QueuedMessageCard({
  message,
  pendingAction,
  onAction,
}: {
  message: QueuedUserMessage
  pendingAction?: QueuedMessageAction
  onAction: (id: string, action: QueuedMessageAction) => void
}) {
  const disabled = pendingAction !== undefined
  return (
    <div className="group rounded-xl bg-black/[0.04] px-3 py-1.5 text-xs text-[var(--wc-muted)]">
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 truncate">已排队 · {message.text}</div>
        <div className="flex shrink-0 items-center gap-0.5" aria-label="排队消息操作">
          <QueuedActionButton
            action="edit"
            label="重新编辑"
            disabled={disabled}
            pending={pendingAction === 'edit'}
            onClick={() => onAction(message.id, 'edit')}
          >
            <Pencil size={13} />
          </QueuedActionButton>
          <QueuedActionButton
            action="discard"
            label="丢弃"
            disabled={disabled}
            pending={pendingAction === 'discard'}
            onClick={() => onAction(message.id, 'discard')}
          >
            <Trash2 size={13} />
          </QueuedActionButton>
          <QueuedActionButton
            action="send-now"
            label="马上发送"
            disabled={disabled}
            pending={pendingAction === 'send-now'}
            onClick={() => onAction(message.id, 'send-now')}
          >
            <SendHorizontal size={13} />
          </QueuedActionButton>
        </div>
      </div>
      <SkillBadges skills={message.skills} />
      <QueuedImageStrip attachments={message.attachments} />
      <QueuedPdfStrip attachments={message.pdfAttachments} />
    </div>
  )
}

function QueuedActionButton({
  action,
  label,
  disabled,
  pending,
  onClick,
  children,
}: {
  action: QueuedMessageAction
  label: string
  disabled: boolean
  pending: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`wc-focus-ring rounded-md p-1 transition-colors disabled:cursor-default ${
        action === 'discard'
          ? 'hover:bg-red-500/[0.06] hover:text-[var(--wc-danger)]'
          : 'hover:bg-black/[0.05] hover:text-[var(--wc-ink)]'
      } ${disabled && !pending ? 'opacity-35' : ''}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      {pending ? <LoaderCircle size={13} className="animate-spin" /> : children}
    </button>
  )
}
