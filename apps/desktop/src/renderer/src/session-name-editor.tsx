import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { MAX_SESSION_NAME_LENGTH } from '../../shared/session-name.ts'
import { SettingsButton } from './settings-layout.tsx'

export type RenameSession = (sessionId: string, name: string) => Promise<boolean>
interface NameProps { sessionId: string; title: string; onRename: RenameSession }

export function SessionNameDialog({ sessionId, title, onRename, onClose }: NameProps & { onClose: () => void }) {
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
    <Dialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none"
      onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}>
      <Dialog.Title className="text-base font-semibold">重命名会话</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-[var(--wc-muted)]">为这个会话起一个便于查找的名称。</Dialog.Description>
      <SessionNameForm sessionId={sessionId} title={title} onRename={onRename} onClose={onClose} />
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

export function SessionTitle({ sessionId, title, disabled, onRename }: {
  sessionId: string | null; title: string; disabled: boolean; onRename: RenameSession
}) {
  const [editing, setEditing] = useState(false)
  return <div className="min-w-0 max-w-64 text-sm font-semibold tracking-tight">
    {editing && sessionId ? <SessionNameForm inline sessionId={sessionId} title={title} onRename={onRename} onClose={() => setEditing(false)} /> : (
      <h1><button type="button" className="wc-focus-ring block max-w-full truncate rounded-md py-1 text-left hover:bg-black/[0.035] disabled:cursor-default disabled:hover:bg-transparent"
        title={title} aria-label={`重命名会话 ${title}`} disabled={disabled || !sessionId} onClick={() => setEditing(true)}>{title}</button></h1>
    )}
  </div>
}

function SessionNameForm({ sessionId, title, onRename, onClose, inline = false }: NameProps & {
  onClose: () => void; inline?: boolean
}) {
  const [value, setValue] = useState(title)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const closed = useRef(false)
  useEffect(() => {
    const input = inputRef.current
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
    if (input) input.scrollLeft = input.scrollWidth
  }, [])
  const close = () => { closed.current = true; onClose() }
  const save = async () => {
    if (inFlight.current || closed.current) return
    if (value.trim() === title) { close(); return }
    inFlight.current = true
    setPending(true)
    try {
      if (await onRename(sessionId, value)) close()
    } finally { inFlight.current = false; setPending(false) }
  }
  return <form className={inline ? 'max-w-full' : 'mt-4'} aria-busy={pending} onSubmit={event => { event.preventDefault(); void save() }}>
    <input ref={inputRef} aria-label="会话名称" value={value} maxLength={MAX_SESSION_NAME_LENGTH} readOnly={pending}
      className={inline ? 'wc-session-title-input wc-focus-ring min-w-0 max-w-full rounded-md border border-[var(--wc-line-strong)] bg-white px-1 py-1 outline-none' : 'wc-settings-input w-full'}
      style={inline ? { width: `${Math.min(32, Math.max(8, value.length + 2))}ch` } : undefined}
      onChange={event => setValue(event.target.value)}
      onBlur={inline ? () => void save() : undefined}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) { if (event.key === 'Enter') event.preventDefault(); return }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      }} />
    {!inline && <div className="mt-5 flex justify-end gap-2">
      <SettingsButton type="button" disabled={pending} onClick={close}>取消</SettingsButton>
      <SettingsButton type="submit" variant="primary" disabled={pending || !value.trim()}>{pending ? '保存中…' : '保存'}</SettingsButton>
    </div>}
  </form>
}
