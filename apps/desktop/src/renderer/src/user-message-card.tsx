import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Block } from './conversation-state.ts'
import { UserImageGallery } from './image-attachments.tsx'
import { UserPdfGallery } from './pdf-attachments.tsx'
import { SkillBadges } from './skill-picker.tsx'
import { MessageActions } from './message-actions.tsx'

type UserBlock = Extract<Block, { kind: 'user' }>

const MESSAGE_EDITOR_BASE_HEIGHT_PX = 64
const MESSAGE_EDITOR_MAX_HEIGHT_PX = MESSAGE_EDITOR_BASE_HEIGHT_PX * 2.5

interface UserMessageCardProps {
  runtimeId: string
  block: UserBlock
  editable: boolean
  disabled: boolean
  onEdit: (turnId: string, text: string) => Promise<boolean>
}

export function UserMessageCard(props: UserMessageCardProps) {
  const editor = useMessageEditor(props.block, props.onEdit)
  return (
    <div
      data-conversation-navigator-target={props.block.id}
      className={`group ml-auto flex max-w-[84%] flex-col items-end gap-2 text-sm leading-6 ${
        editor.editing ? 'mb-8' : 'mb-2'
      }`}
    >
      <UserImageGallery attachments={props.block.attachments} />
      <UserPdfGallery runtimeId={props.runtimeId} attachments={props.block.pdfAttachments} />
      <SkillBadges skills={props.block.skills} />
      {editor.editing
        ? (
          <div className="wc-user-message-bubble wc-user-message-editor w-[min(36rem,78vw)] px-3.5 py-2.5">
            <MessageEditor
              editable={props.editable}
              disabled={props.disabled}
              editor={editor}
            />
          </div>
        )
        : props.block.text && (
          <div className="wc-user-message-bubble relative flex min-h-11 w-fit max-w-full items-center px-3.5 py-2.5">
            <div className="whitespace-pre-wrap">{props.block.text}</div>
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

interface MessageEditorState {
  editing: boolean
  draft: string
  submitting: boolean
  error: string | null
  setDraft: (text: string) => void
  begin: () => void
  cancel: () => void
  submit: (allowed: boolean) => Promise<void>
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
  const submit = async (allowed: boolean) => {
    const text = draft.trim()
    if (!allowed || submitting || !block.turnId || !text) return
    setSubmitting(true)
    setError(null)
    try {
      if (await onEdit(block.turnId, text)) setEditing(false)
      else setError('重新发送失败，请重试')
    } catch {
      setError('重新发送失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }
  return { editing, draft, submitting, error, setDraft, begin, cancel, submit }
}

function MessageEditor({
  editable,
  disabled,
  editor,
}: {
  editable: boolean
  disabled: boolean
  editor: MessageEditorState
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    resizeMessageEditor(textarea)
  }, [editor.draft])
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])
  const allowed = editable && !disabled
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    void editor.submit(allowed)
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea
        ref={textareaRef}
        rows={2}
        className="block w-full resize-none overflow-y-hidden border-0 bg-transparent p-0 outline-none"
        style={{
          minHeight: MESSAGE_EDITOR_BASE_HEIGHT_PX,
          maxHeight: MESSAGE_EDITOR_MAX_HEIGHT_PX,
        }}
        value={editor.draft}
        disabled={disabled || editor.submitting}
        onChange={(event) => editor.setDraft(event.target.value)}
        onKeyDown={(event) => handleEditorKeyDown(event, editor.cancel, submit)}
        aria-label="编辑用户消息"
      />
      {editor.error && <div className="text-xs text-[var(--wc-danger)]">{editor.error}</div>}
      <EditorActions
        draft={editor.draft}
        disabled={!allowed}
        submitting={editor.submitting}
        onCancel={editor.cancel}
      />
    </form>
  )
}

function resizeMessageEditor(textarea: HTMLTextAreaElement): void {
  textarea.style.overflowY = 'hidden'
  textarea.style.height = '0px'
  const contentHeight = textarea.scrollHeight
  const height = Math.min(
    Math.max(contentHeight, MESSAGE_EDITOR_BASE_HEIGHT_PX),
    MESSAGE_EDITOR_MAX_HEIGHT_PX,
  )
  textarea.style.height = `${height}px`
  textarea.style.overflowY = contentHeight > MESSAGE_EDITOR_MAX_HEIGHT_PX ? 'auto' : 'hidden'
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
    <div className="flex justify-end gap-2 text-xs">
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
