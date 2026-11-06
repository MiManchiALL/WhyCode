import type { QueuedUserMessage } from '@whycode/core/events'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { ChevronDown, ListCollapse, LoaderCircle, Pencil, SendHorizontal, Trash2 } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import type { ComposerDraft } from './composer-drafts.ts'
import { QueuedImageStrip } from './image-attachments.tsx'
import { QueuedPdfStrip } from './pdf-attachments.tsx'
import { SkillBadges } from './skill-picker.tsx'

export type QueuedMessageAction = 'edit' | 'discard' | 'send-now'

interface QueuedMessageProps {
  message: QueuedUserMessage
  confirmOverwrite: boolean
  editDisabled: boolean
  pendingAction?: QueuedMessageAction
  onAction: (id: string, action: QueuedMessageAction) => void
}

export function QueuedMessageList({
  messages, submitting, collapsed, onCollapsedChange, confirmOverwrite, editDisabled, pendingActions, onAction,
}: Pick<QueuedMessageProps, 'confirmOverwrite' | 'editDisabled' | 'onAction'> & {
  messages: readonly QueuedUserMessage[]
  submitting: ComposerDraft | null
  collapsed: boolean
  onCollapsedChange: (collapsed: boolean) => void
  pendingActions: Partial<Record<string, QueuedMessageAction>>
}) {
  const listId = useId()
  const count = messages.length + (submitting ? 1 : 0)
  const expanded = !collapsed
  return (
    <div className="mb-2">
      <button
        type="button" aria-expanded={expanded} aria-controls={listId}
        className="wc-focus-ring mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-1 text-xs text-[var(--wc-muted)] hover:bg-black/[0.04]"
        onClick={() => onCollapsedChange(!collapsed)}
      >
        <ListCollapse size={14} />
        <span>{count} 条排队消息</span>
        <ChevronDown size={14} className={`ml-auto ${expanded ? '' : '-rotate-90'}`} />
      </button>
      <div
        id={listId}
        hidden={!expanded}
        className={`space-y-1 overflow-y-auto overscroll-contain ${count > 3 ? 'max-h-[min(7rem,25dvh)]' : 'max-h-[25dvh]'}`}
      >
        {expanded && messages.map(message => (
          <QueuedMessageCard
            key={message.id}
            message={message}
            confirmOverwrite={confirmOverwrite}
            editDisabled={editDisabled}
            pendingAction={pendingActions[message.id]}
            onAction={onAction}
          />
        ))}
        {expanded && submitting && <QueuedMessageCard draft={submitting} />}
      </div>
    </div>
  )
}

function QueuedMessageCard(props: QueuedMessageProps | { draft: ComposerDraft }) {
  const submitting = 'draft' in props
  const message = submitting ? props.draft : props.message
  return (
    <div aria-busy={submitting || undefined} className="group rounded-xl bg-black/[0.04] px-3 py-1.5 text-xs text-[var(--wc-muted)]">
      <div className="flex min-h-5.5 min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1 truncate">{submitting ? '正在提交' : '已排队'} · {message.text}</div>
        {!submitting && <QueuedMessageActions {...props} />}
      </div>
      <SkillBadges skills={message.skills} />
      <QueuedImageStrip attachments={submitting ? props.draft.images : props.message.attachments} />
      <QueuedPdfStrip attachments={submitting ? props.draft.pdfs : props.message.pdfAttachments} />
    </div>
  )
}

function QueuedMessageActions({ message, confirmOverwrite, editDisabled, pendingAction, onAction }: QueuedMessageProps) {
  const disabled = pendingAction !== undefined
  return (
    <div className="flex shrink-0 items-center gap-0.5" aria-label="排队消息操作">
      <QueuedActionButton
        action="edit"
        label="重新编辑"
        disabled={disabled || editDisabled}
        confirmOverwrite={confirmOverwrite}
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
  )
}

function QueuedActionButton({
  action,
  label,
  disabled,
  pending,
  onClick,
  confirmOverwrite,
  children,
}: {
  action: QueuedMessageAction
  label: string
  disabled: boolean
  pending: boolean
  onClick: () => void
  confirmOverwrite?: boolean
  children: ReactNode
}) {
  const button = (
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
      onClick={confirmOverwrite ? undefined : onClick}
    >
      {pending ? <LoaderCircle size={13} className="animate-spin" /> : children}
    </button>
  )
  if (!confirmOverwrite) return button
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger asChild>{button}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
        <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] w-[min(92vw,360px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none">
          <AlertDialog.Title className="text-base font-semibold">覆盖当前草稿？</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-[var(--wc-muted)]">输入框里的内容将替换为这条排队消息。</AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel className="wc-focus-ring rounded-xl border border-[var(--wc-line)] px-3 py-2 text-sm">取消</AlertDialog.Cancel>
            <AlertDialog.Action disabled={disabled} onClick={onClick} className="wc-focus-ring rounded-xl bg-[var(--wc-ink)] px-3 py-2 text-sm text-white">确定</AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
