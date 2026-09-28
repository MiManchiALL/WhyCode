import { useCallback, useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowUp, Folder } from 'lucide-react'
import type { SshConnection, SshDirectory } from '../../shared/ssh.ts'
import { useConversationFeedback } from './conversation-feedback.tsx'
import { SettingsButton } from './settings-layout.tsx'

export function SshDirectoryPicker({ connection, onClose }: { connection: SshConnection; onClose: () => void }) {
  const [directory, setDirectory] = useState<SshDirectory | null>(null)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const feedback = useConversationFeedback()
  const load = useCallback(async (target?: string) => {
    setBusy(true)
    try {
      const result = await window.whycode.ssh({ action: 'directory', id: connection.id, path: target })
      if (!result.ok) throw new Error(result.error)
      if (result.directory) { setDirectory(result.directory); setPath(result.directory.path) }
    } catch (error) { feedback('error', error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }, [connection.id, feedback])
  useEffect(() => { void load() }, [load])
  const choose = async () => {
    if (!directory || busy) return
    setBusy(true)
    try {
      const result = await window.whycode.ssh({ action: 'project', id: connection.id, path: directory.path })
      if (!result.ok) throw new Error(result.error)
      feedback('success', '已添加远端项目'); onClose()
    } catch (error) { feedback('error', error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
    <Dialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,600px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6 outline-none">
      <Dialog.Title className="text-base font-semibold">选择远端项目</Dialog.Title>
      <Dialog.Description className="mt-1 break-words text-sm text-[var(--wc-muted)]">{connection.name} · {connection.username}@{connection.host}</Dialog.Description>
      <form className="my-4 flex gap-2" onSubmit={event => { event.preventDefault(); if (!busy) void load(path) }}>
        <SettingsButton aria-label="上一级文件夹" disabled={busy || !directory || directory.path === '/'} onClick={() => void load(directory!.path.split('/').slice(0, -1).join('/') || '/')}><ArrowUp size={16} /></SettingsButton>
        <input className="wc-settings-input min-w-0 flex-1" aria-label="远端文件夹路径" title="输入路径后按 Enter 前往" value={path} onChange={event => setPath(event.target.value)} />
      </form>
      <div className="wc-scrollbar h-64 overflow-y-auto rounded-xl border border-[var(--wc-line)] p-2" aria-busy={busy}>
        {!directory?.directories.length && <p className="p-4 text-sm text-[var(--wc-faint)]">{busy ? '正在读取…' : '没有子文件夹'}</p>}
        {directory?.directories.map(name => <button key={name} disabled={busy} type="button" className="wc-menu-item w-full text-left" onClick={() => void load(`${directory.path.replace(/\/$/u, '')}/${name}`)}><Folder size={16} className="shrink-0" /><span className="truncate">{name}</span></button>)}
      </div>
      <div className="mt-5 flex justify-end gap-2"><SettingsButton disabled={busy} onClick={onClose}>取消</SettingsButton><SettingsButton variant="primary" disabled={busy || !directory} onClick={() => void choose()}>选择此文件夹</SettingsButton></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
