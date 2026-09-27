import { useState } from 'react'
import { MAX_SESSION_NAME_LENGTH } from '../../shared/session-name.ts'
import { NameEditorDialog, NameEditorForm } from './name-editor.tsx'

export type RenameSession = (sessionId: string, name: string) => Promise<boolean>

export function SessionNameDialog({ sessionId, title, onRename, onClose }: {
  sessionId: string; title: string; onRename: RenameSession; onClose: () => void
}) {
  return <NameEditorDialog id={sessionId} title={title} onRename={onRename} onClose={onClose}
    label="会话" maxLength={MAX_SESSION_NAME_LENGTH} description="为这个会话起一个便于查找的名称。" />
}

export function SessionTitle({ sessionId, title, disabled, onRename }: {
  sessionId: string | null; title: string; disabled: boolean; onRename: RenameSession
}) {
  const [editing, setEditing] = useState(false)
  return <div className="min-w-0 max-w-64 text-sm font-semibold tracking-tight">
    {editing && sessionId ? <NameEditorForm inline id={sessionId} label="会话" maxLength={MAX_SESSION_NAME_LENGTH} title={title} onRename={onRename} onClose={() => setEditing(false)} /> : (
      <h1><button type="button" className="wc-focus-ring block max-w-full truncate rounded-md py-1 text-left hover:bg-black/[0.035] disabled:cursor-default disabled:hover:bg-transparent"
        title={title} aria-label={`重命名会话 ${title}`} disabled={disabled || !sessionId} onClick={() => setEditing(true)}>{title}</button></h1>
    )}
  </div>
}
