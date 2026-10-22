import { useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Folder, Loader2, RefreshCw, X } from 'lucide-react'
import type { SshConnectionSnapshot, SshConnectionInput } from '../../shared/ssh.ts'
import type { RemoteMcpProject, RemoteMcpSelection } from '../../shared/ssh-mcp.ts'
import { SettingsButton } from './settings-layout.tsx'
import { SshConnectionEditor } from './ssh-connection-editor.tsx'

export function SshMcpDialog({ connection, onClose }: { connection: SshConnectionSnapshot; onClose: () => void }) {
  const [rows, setRows] = useState<RemoteMcpProject[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [credentials, setCredentials] = useState(false)
  const [selection, setSelection] = useState<RemoteMcpSelection[] | null>(null)
  const [lookup, setLookup] = useState<string | null>(null)
  const alive = useRef(true)
  const generation = useRef(0)
  const refresh = useCallback(async (directory?: string) => {
    const current = ++generation.current
    setBusy(true); setError(null)
    try {
      const result = await window.whycode.ssh({ action: 'mcp-list', id: connection.id, directory })
      if (!alive.current || generation.current !== current) return
      if (!result.ok) { setError(result.error); if (result.credentialsRequired) setCredentials(true); return }
      setRows(result.mcpProjects ?? [])
      if (directory && !result.mcpProjects?.some(row => row.directory === directory)) setError('此项目没有 .whycode/mcp.json')
      else setLookup(null)
    } catch (cause) { if (alive.current && generation.current === current) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (alive.current && generation.current === current) setBusy(false) }
  }, [connection.id])
  useEffect(() => {
    alive.current = true; void refresh()
    return () => { alive.current = false; generation.current++ }
  }, [refresh])
  const remove = async (projects: RemoteMcpSelection[]) => {
    setSelection(null); setBusy(true); setError(null)
    let failure: string | null = null
    try {
      const result = await window.whycode.ssh({ action: 'mcp-remove', id: connection.id, projects })
      if (!result.ok) failure = result.error
    } catch (cause) { failure = cause instanceof Error ? cause.message : String(cause) }
    if (!alive.current) return
    await refresh()
    if (alive.current && failure) setError(failure)
  }
  const saveCredentials = async (value: SshConnectionInput) => {
    try {
      const result = await window.whycode.ssh({ action: 'save', connection: value })
      if (!alive.current) return
      if (!result.ok) { setError(result.error); return }
      setCredentials(false); await refresh()
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  const removable = rows.flatMap(row => row.digest ? [{ directory: row.directory, digest: row.digest }] : [])
  return <>
    <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose() }}><Dialog.Portal>
      <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
      <Dialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] flex max-h-[85vh] w-[min(92vw,600px)] -translate-x-1/2 -translate-y-1/2 flex-col p-5 outline-none"
        onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }} onInteractOutside={event => event.preventDefault()}>
        <div className="flex items-center justify-between gap-3">
          <Dialog.Title className="text-base font-semibold">管理远端 MCP 配置</Dialog.Title>
          <Dialog.Close asChild><button disabled={busy} aria-label="关闭 MCP 管理" className="wc-focus-ring rounded-lg p-1.5 hover:bg-black/[0.05]"><X size={17} /></button></Dialog.Close>
        </div>
        <Dialog.Description className="mt-2 truncate text-sm text-[var(--wc-muted)]" title={connection.name}>{connection.name}</Dialog.Description>
        <div className="wc-scrollbar mt-5 min-h-24 overflow-y-auto rounded-xl border border-[var(--wc-line)]">
          {rows.map(row => <div key={row.directory} className="flex min-w-0 items-center gap-3 border-b border-[var(--wc-line)] px-4 py-3 last:border-b-0">
            <Folder size={18} className="shrink-0 text-[var(--wc-faint)]" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{row.directory.split('/').filter(Boolean).at(-1) ?? '/'}</div>
              <div className="mt-0.5 truncate text-xs text-[var(--wc-muted)]" title={row.directory}>{row.directory}</div>
              {row.error && <p className="mt-1 break-words text-xs text-[var(--wc-danger)]">{row.error}</p>}
              {row.incomplete && <p className="mt-1 text-xs text-[var(--wc-muted)]">有未完成的配置写入</p>}
            </div>
            <SettingsButton disabled={busy || !row.digest} onClick={() => row.digest && setSelection([{ directory: row.directory, digest: row.digest }])} aria-label={`删除 ${row.directory} 的 MCP 配置`}>删除</SettingsButton>
          </div>)}
          {!rows.length && <div className="flex min-h-32 items-center justify-center gap-2 px-4 py-8 text-sm text-[var(--wc-muted)]">{busy ? <><Loader2 size={16} className="animate-spin" />读取中…</> : '暂无项目 MCP 配置'}</div>}
        </div>
        {error && <p role="alert" className="mt-3 break-words text-sm text-[var(--wc-danger)]">{error}</p>}
        {lookup !== null && <form className="mt-3 flex gap-2" onSubmit={event => { event.preventDefault(); if (!busy) void refresh(lookup.trim()) }}>
          <input autoFocus required aria-label="远端项目路径" className="wc-settings-input min-w-0 flex-1 text-sm" placeholder="/home/user/project" value={lookup} onChange={event => setLookup(event.target.value)} disabled={busy} />
          <SettingsButton type="submit" disabled={busy}>查找</SettingsButton>
        </form>}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2"><SettingsButton disabled={busy} aria-label="刷新 MCP 配置" onClick={() => void refresh()}><RefreshCw size={14} /></SettingsButton><SettingsButton disabled={busy} onClick={() => setLookup(value => value === null ? '' : null)}>查找项目</SettingsButton></div>
          {rows.length > 0 && <SettingsButton disabled={busy || removable.length !== rows.length} onClick={() => setSelection(removable)}>删除全部项目配置</SettingsButton>}
        </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
    {selection && <AlertDialog.Root open onOpenChange={open => { if (!open) setSelection(null) }}><AlertDialog.Portal>
      <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[95] bg-black/20" />
      <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[96] w-[min(92vw,480px)] -translate-x-1/2 -translate-y-1/2 p-5 outline-none" onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}>
        <AlertDialog.Title className="text-base font-semibold">{selection.length === 1 ? '删除此项目的 MCP 配置？' : `删除这 ${selection.length} 个项目的 MCP 配置？`}</AlertDialog.Title>
        <AlertDialog.Description className="mt-2 text-sm leading-6 text-[var(--wc-muted)]">删除项目中的 .whycode/mcp.json，并关闭对应 MCP 连接。此操作无法撤销。</AlertDialog.Description>
        <ul className="wc-scrollbar mt-3 max-h-40 space-y-2 overflow-y-auto rounded-xl bg-black/[0.025] p-3 text-xs leading-5 text-[var(--wc-muted)]">{selection.map(row => <li key={row.directory} className="break-all">{row.directory}</li>)}</ul>
        <div className="mt-5 flex justify-end gap-2"><AlertDialog.Cancel asChild><SettingsButton>取消</SettingsButton></AlertDialog.Cancel><AlertDialog.Action asChild><SettingsButton variant="danger" onClick={() => void remove(selection)}>确认删除</SettingsButton></AlertDialog.Action></div>
      </AlertDialog.Content>
    </AlertDialog.Portal></AlertDialog.Root>}
    {credentials && <SshConnectionEditor connection={connection} purpose="mcp" onClose={() => setCredentials(false)} onSave={saveCredentials} />}
  </>
}
