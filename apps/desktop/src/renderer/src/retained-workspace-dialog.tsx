import { useEffect, useState } from 'react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import * as Dialog from '@radix-ui/react-dialog'
import type { RetainedWorkspace, WorkspaceDeletionPreview } from '../../shared/workspace-lifecycle.ts'
import { SettingsButton } from './settings-layout.tsx'

interface Props {
  workspace: RetainedWorkspace
  onClose: () => void
  onChanged: () => void
  onError: (message: string) => void
}

const overlay = 'wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]'
const card = 'wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none'

export function RenameRetainedWorkspace({ workspace, onClose, onChanged, onError }: Props) {
  const [name, setName] = useState(workspace.name)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (busy || !name.trim()) return
    setBusy(true)
    try {
      const result = await window.whycode.renameRetainedWorkspace(workspace, name)
      if (!result.ok) throw new Error(result.error)
      onChanged()
      onClose()
    } catch (error) { onError(`重命名失败：${message(error)}`) } finally { setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className={overlay} />
    <Dialog.Content className={card} onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}>
      <Dialog.Title className="text-base font-semibold">重命名工作区</Dialog.Title>
      <Dialog.Description className="mt-2 text-sm text-[var(--wc-muted)]">仅修改 WhyCode 中的名称，文件夹名称和路径保持不变。</Dialog.Description>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        <input aria-label="工作区名称" className="wc-settings-input mt-4 w-full" value={name} onChange={event => setName(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} maxLength={200} disabled={busy} />
        <div className="mt-5 flex justify-end gap-2">
          <SettingsButton type="button" onClick={onClose} disabled={busy}>取消</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={busy || !name.trim()}>{busy ? '保存中…' : '保存'}</SettingsButton>
        </div>
      </form>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

export function DeleteRetainedWorkspace({ workspace, onClose, onChanged, onError }: Props) {
  const [preview, setPreview] = useState<WorkspaceDeletionPreview | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    void window.whycode.previewRetainedWorkspace(workspace).then(result => {
      if (cancelled) return
      if (!result.ok) throw new Error(result.error)
      setPreview(result.value)
    }).catch(error => {
      if (!cancelled) { onError(`无法清理工作区：${message(error)}`); onClose(); onChanged() }
    })
    return () => { cancelled = true }
  }, [workspace, onClose, onChanged, onError])
  const remove = async () => {
    if (busy || !preview) return
    setBusy(true)
    try {
      const result = await window.whycode.deleteRetainedWorkspace(workspace)
      if (!result.ok) throw new Error(result.error)
      onChanged()
      onClose()
    } catch (error) { onError(`清理失败：${message(error)}`) } finally { setBusy(false) }
  }
  return <AlertDialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><AlertDialog.Portal>
    <AlertDialog.Overlay className={overlay} />
    <AlertDialog.Content className={card}>
      <AlertDialog.Title className="text-base font-semibold">清理这个工作区？</AlertDialog.Title>
      <AlertDialog.Description className="mt-2 text-sm leading-6 text-[var(--wc-muted)]">
        {preview ? preview.disposition === 'missing' ? '目录已不存在，将移除保留记录。' : '工作目录及其中的全部文件将被永久删除，无法撤销。' : '正在确认工作目录…'}
      </AlertDialog.Description>
      <p className="mt-3 break-all rounded-xl bg-black/[0.035] px-3 py-2 text-xs text-[var(--wc-muted)]">{workspace.directory}</p>
      {preview?.warning && <p className="mt-3 text-xs leading-5 text-[var(--wc-danger)]">{preview.warning}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel asChild><SettingsButton disabled={busy}>取消</SettingsButton></AlertDialog.Cancel>
        <AlertDialog.Action asChild><SettingsButton variant="danger" disabled={busy || !preview} onClick={event => { event.preventDefault(); void remove() }}>{busy ? '清理中…' : '删除工作目录'}</SettingsButton></AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal></AlertDialog.Root>
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
