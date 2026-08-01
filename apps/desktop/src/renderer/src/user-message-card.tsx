import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Block } from './conversation-state.ts'
import { UserImageGallery } from './image-attachments.tsx'
import { UserPdfGallery } from './pdf-attachments.tsx'
import { SkillBadges } from './skill-picker.tsx'

type UserBlock = Extract<Block, { kind: 'user' }>

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
    <div className="group relative mb-2 rounded bg-neutral-200/60 px-3 py-2 text-sm">
      <UserImageGallery attachments={props.block.attachments} />
      <UserPdfGallery runtimeId={props.runtimeId} attachments={props.block.pdfAttachments} />
      <SkillBadges skills={props.block.skills} />
      {editor.editing
        ? (
          <MessageEditor
            editable={props.editable}
            disabled={props.disabled}
            editor={editor}
          />
        )
        : (
          <MessageDisplay
            block={props.block}
            editable={props.editable}
            disabled={props.disabled}
            begin={editor.begin}
          />
        )}
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
      else setError('编辑重跑失败，请重试')
    } catch {
      setError('编辑重跑失败，请重试')
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
        className="max-h-48 min-h-16 w-full resize-y rounded border border-neutral-400 bg-white px-2 py-1.5 outline-none focus:border-neutral-700"
        value={editor.draft}
        disabled={disabled || editor.submitting}
        onChange={(event) => editor.setDraft(event.target.value)}
        onKeyDown={(event) => handleEditorKeyDown(event, editor.cancel, submit)}
        aria-label="编辑用户消息"
      />
      {editor.error && <div className="text-xs text-red-600">{editor.error}</div>}
      <EditorActions
        draft={editor.draft}
        disabled={!allowed}
        submitting={editor.submitting}
        onCancel={editor.cancel}
      />
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
    <div className="flex justify-end gap-2 text-xs">
      <button
        type="button"
        className="rounded border border-neutral-300 bg-white px-2 py-1"
        disabled={submitting}
        onClick={onCancel}
      >
        取消
      </button>
      <button
        type="submit"
        className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
        disabled={disabled || submitting || !draft.trim()}
      >
        {submitting ? '重跑中…' : '保存并重新运行'}
      </button>
    </div>
  )
}

function MessageDisplay({
  block,
  editable,
  disabled,
  begin,
}: {
  block: UserBlock
  editable: boolean
  disabled: boolean
  begin: () => void
}) {
  return (
    <>
      <div className="whitespace-pre-wrap pr-10">{block.text}</div>
      {editable && (
        <button
          type="button"
          className="absolute right-2 top-2 rounded bg-white/90 px-2 py-0.5 text-xs text-neutral-500 opacity-0 shadow-sm transition-opacity hover:text-neutral-900 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
          disabled={disabled}
          onClick={begin}
        >
          编辑
        </button>
      )}
    </>
  )
}
