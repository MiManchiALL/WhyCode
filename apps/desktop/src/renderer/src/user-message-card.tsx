import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Block } from '../../shared/conversation-state.ts'
import { UserImageGallery } from './image-attachments.tsx'
import { UserPdfGallery } from './pdf-attachments.tsx'
import { SkillBadges } from './skill-picker.tsx'
import { MessageEditEffects, useMessageEditEffects } from './message-edit-effects.tsx'
import { MessageActions } from './message-actions.tsx'

type UserBlock = Extract<Block, { kind: 'user' }>

const COLLAPSED_MESSAGE_LINES = 12

interface UserMessageCardProps {
  runtimeId: string
  block: UserBlock
  editable: boolean
  disabled: boolean
  onEdit: (block: UserBlock, text: string, restoreFiles: boolean) => Promise<boolean>
}

export function UserMessageCard(props: UserMessageCardProps) {
  const editor = useMessageEditor(props.block, props.onEdit)
  return (
    <div
      data-conversation-navigator-target={props.block.id}
      className={`wc-user-message-copy group ml-auto flex w-full min-w-0 flex-col items-end gap-2 ${
        editor.editing ? 'mb-8' : 'mb-2 max-w-[84%]'
      }`}
    >
      <UserImageGallery attachments={props.block.attachments} />
      <UserPdfGallery runtimeId={props.runtimeId} attachments={props.block.pdfAttachments} />
      <SkillBadges skills={props.block.skills} />
      {editor.editing
        ? (
          <div className={`wc-user-message-bubble wc-user-message-editor w-full min-w-0 px-3.5 py-2.5 ${
            props.block.btw ? 'wc-user-message-bubble-btw' : ''
          }`}>
            <MessageEditor
              runtimeId={props.runtimeId}
              turnId={props.block.btw ? undefined : props.block.turnId}
              editable={props.editable}
              disabled={props.disabled}
              editor={editor}
            />
          </div>
        )
        : props.block.text && (
          <div className={`wc-user-message-bubble relative flex min-h-11 min-w-0 w-fit max-w-full flex-col items-start px-3.5 py-2.5 ${
            props.block.btw ? 'wc-user-message-bubble-btw' : ''
          }`}>
            <UserMessageText text={props.block.text} />
          </div>
        )}
      {!editor.editing ? (
        <MessageActions
          timestamp={props.block.timestamp}
          text={props.block.text}
          editable={props.editable && !props.disabled}
          onEdit={editor.begin}
          className="-mt-1"
        />
      ) : null}
    </div>
  )
}

function UserMessageText({ text }: { text: string }) {
  const contentId = useId()
  const contentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useEffect(() => setExpanded(false), [text])
  useLayoutEffect(() => {
    const element = contentRef.current!
    const measure = () => {
      // 不为离屏历史强制布局；进入可见区后 ResizeObserver 会再次测量。
      if (!element.checkVisibility({ contentVisibilityAuto: true })) return
      setOverflows(
        element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * COLLAPSED_MESSAGE_LINES + 1,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [text])
  return (
    <>
      <div
        id={contentId}
        ref={contentRef}
        className="wc-user-message-text min-w-0 max-w-full overflow-hidden whitespace-pre-wrap [overflow-wrap:anywhere]"
        data-collapsed={overflows && !expanded}
        style={{ maxHeight: expanded ? undefined : `${COLLAPSED_MESSAGE_LINES}lh` }}
      >
        {text}
      </div>
      {overflows && (
        <button
          type="button"
          className="wc-focus-ring wc-type-control -ml-1 mt-2 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[var(--wc-muted)] hover:bg-black/5 hover:text-[var(--wc-ink)]"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '展开全文'}
          <ChevronDown size={14} className={`transition-transform duration-150 motion-reduce:transition-none ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      )}
    </>
  )
}

interface MessageEditorState {
  editing: boolean
  draft: string
  submitting: boolean
  error: string | null
  setDraft: (text: string) => void
  begin: () => void
  cancel: () => void
  submit: (allowed: boolean, restoreFiles: boolean) => Promise<void>
}

function useMessageEditor(
  block: UserBlock,
  onEdit: UserMessageCardProps['onEdit'],
): MessageEditorState {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(block.text)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!editing) setDraft(block.text)
  }, [block.text, editing])
  const begin = () => {
    setDraft(block.text)
    setError(null)
    setEditing(true)
  }
  const cancel = () => {
    if (submitting) return
    setDraft(block.text)
    setError(null)
    setEditing(false)
  }
  const submit = async (allowed: boolean, restoreFiles: boolean) => {
    const text = draft.trim()
    if (!allowed || submitting || !text) return
    setSubmitting(true)
    setError(null)
    try {
      if (await onEdit(block, text, restoreFiles)) setEditing(false)
      else setError('重新发送失败，请重试')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重新发送失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }
  return { editing, draft, submitting, error, setDraft, begin, cancel, submit }
}

function MessageEditor({
  runtimeId,
  turnId,
  editable,
  disabled,
  editor,
}: {
  runtimeId: string
  turnId: string | undefined
  editable: boolean
  disabled: boolean
  editor: MessageEditorState
}) {
  const [restoreFiles, setRestoreFiles] = useState(false)
  const inspection = useMessageEditEffects(runtimeId, turnId)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])
  const allowed = editable && !disabled && inspection.effects !== null
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    void editor.submit(allowed, restoreFiles && inspection.effects?.hasFileChanges === true)
  }
  return (
    <form onSubmit={submit} className="w-full min-w-0 space-y-2">
      <textarea
        ref={textareaRef}
        rows={2}
        className="wc-scrollbar block max-h-40 min-h-16 w-full min-w-0 resize-none overflow-y-auto border-0 bg-transparent p-0 outline-none [field-sizing:content]"
        value={editor.draft}
        disabled={disabled || editor.submitting}
        onChange={(event) => editor.setDraft(event.target.value)}
        onKeyDown={(event) => handleEditorKeyDown(event, editor.cancel, submit)}
        aria-label="编辑用户消息"
      />
      {(editor.error || inspection.error) && <div role="alert" className="text-xs text-[var(--wc-danger)]">{editor.error || inspection.error}</div>}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs">
        {!inspection.error && <MessageEditEffects effects={inspection.effects} checked={restoreFiles}
          disabled={!allowed || editor.submitting} onChange={setRestoreFiles} />}
        <EditorActions
          draft={editor.draft}
          disabled={!allowed}
          submitting={editor.submitting}
          onCancel={editor.cancel}
        />
      </div>
    </form>
  )
}

function handleEditorKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  cancel: () => void,
  submit: () => void,
): void {
  if (event.nativeEvent.isComposing) return
  if (event.key === 'Escape') {
    event.preventDefault()
    cancel()
  } else if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

function EditorActions({
  draft,
  disabled,
  submitting,
  onCancel,
}: {
  draft: string
  disabled: boolean
  submitting: boolean
  onCancel: () => void
}) {
  return (
    <div className="ml-auto flex shrink-0 justify-end gap-2 text-xs">
      <button
        type="button"
        className="wc-focus-ring rounded-xl border border-[var(--wc-line)] bg-white px-2.5 py-1"
        disabled={submitting}
        onClick={onCancel}
      >
        取消
      </button>
      <button
        type="submit"
        className="wc-focus-ring rounded-xl bg-[var(--wc-ink)] px-2.5 py-1 text-white disabled:opacity-40"
        disabled={disabled || submitting || !draft.trim()}
      >
        {submitting ? '发送中…' : '发送'}
      </button>
    </div>
  )
}
