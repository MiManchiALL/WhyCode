import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Folder, FolderOpen, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { RetainedWorkspace } from '../../shared/workspace-lifecycle.ts'
import { DeleteRetainedWorkspace, RenameRetainedWorkspace } from './retained-workspace-dialog.tsx'
import { retainedWorkspaceKey, type RetainedWorkspaceCleanup } from './retained-workspace-cleanup.ts'
import { SettingsButton, SettingsPanel } from './settings-layout.tsx'

export function RetainedWorkspacesSettings({ cleanup, onError }: {
  cleanup: RetainedWorkspaceCleanup
  onError: (message: string) => void
}) {
  const cleaning = useSyncExternalStore(cleanup.subscribe, cleanup.getSnapshot)
  const [items, setItems] = useState<RetainedWorkspace[]>([])
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState<string | null>(null)
  const [selection, setSelection] = useState<{ action: 'rename' | 'delete'; workspace: RetainedWorkspace } | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(() => {
    const current = ++generation.current
    setLoading(true)
    void window.whycode.listRetainedWorkspaces().then(result => {
      if (current !== generation.current) return
      if (!result.ok) throw new Error(result.error)
      setItems(result.value.workspaces)
      if (result.value.warnings.length) onError(`部分工作区记录无法读取：${result.value.warnings[0]}`)
    }).catch(error => {
      if (current === generation.current) onError(`读取保留工作区失败：${message(error)}`)
    }).finally(() => { if (current === generation.current) setLoading(false) })
  }, [onError])
  useEffect(() => { refresh(); return () => { generation.current++ } }, [refresh, cleaning])
  const closeDialog = useCallback(() => setSelection(null), [])
  const open = async (workspace: RetainedWorkspace) => {
    setOpening(workspace.id)
    try {
      const result = await window.whycode.openRetainedWorkspace(workspace)
      if (!result.ok) throw new Error(result.error)
    } catch (error) { onError(`打开工作目录失败：${message(error)}`) } finally { setOpening(null) }
  }

  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3 text-xs text-[var(--wc-muted)]">
      <span>{loading && !items.length ? '正在读取…' : `${items.length} 个工作区 · 最近保留的在前`}</span>
      <SettingsButton onClick={refresh} disabled={loading}><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />刷新</SettingsButton>
    </div>
    <SettingsPanel padded={false} className="overflow-hidden">
      {!items.length ? <div className="px-6 py-12 text-center text-sm text-[var(--wc-muted)]">
        <Folder size={24} className="mx-auto mb-3 text-[var(--wc-faint)]" />
        {loading ? '正在读取保留记录…' : '暂无保留工作区'}
      </div> : <ul className="divide-y divide-[var(--wc-line)]">
        {items.map(workspace => {
          const pending = cleaning.has(retainedWorkspaceKey(workspace))
          return <li key={retainedWorkspaceKey(workspace)} className="flex min-w-0 items-center gap-3 px-4 py-3.5">
            {pending ? <LoaderCircle size={17} className="shrink-0 animate-spin text-[var(--wc-muted)]" /> : <Folder size={17} className="shrink-0 text-[var(--wc-muted)]" />}
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium" title={workspace.name}>{workspace.name}</span>
                <span className="shrink-0 rounded-md bg-black/[0.035] px-1.5 py-0.5 text-[10px] text-[var(--wc-muted)]">{workspace.mode === 'worktree' ? 'Worktree' : '默认工作区'}</span>
              </div>
              <div className="mt-1 flex min-w-0 items-center gap-3 text-xs text-[var(--wc-muted)]">
                <p className="min-w-0 flex-1 truncate" title={workspace.directory}>{workspace.directory}</p>
                {pending ? <span role="status" className="shrink-0 text-[11px]">清理中…</span> : <time className="shrink-0 text-[11px] text-[var(--wc-faint)]" dateTime={workspace.retainedAt} title={`保留于 ${new Date(workspace.retainedAt).toLocaleString()}`}>
                  {new Date(workspace.retainedAt).toLocaleDateString()}
                </time>}
              </div>
            </div>
            <button className="wc-icon-button size-8 shrink-0" aria-label={`打开 ${workspace.name} 的目录`} title="打开目录" disabled={pending || opening !== null} onClick={() => void open(workspace)}><FolderOpen size={16} /></button>
            <DropdownMenu.Root><DropdownMenu.Trigger asChild>
              <button className="wc-icon-button size-8 shrink-0" aria-label={`${workspace.name} 的更多操作`} disabled={pending}><MoreHorizontal size={16} /></button>
            </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={5} className="wc-menu-surface z-[80] min-w-36 p-1.5 text-sm">
              <DropdownMenu.Item className="wc-menu-item cursor-pointer" onSelect={() => setSelection({ action: 'rename', workspace })}><Pencil size={14} />重命名</DropdownMenu.Item>
              <DropdownMenu.Item className="wc-menu-item cursor-pointer text-[var(--wc-danger)]" onSelect={() => setSelection({ action: 'delete', workspace })}><Trash2 size={14} />清理工作区</DropdownMenu.Item>
            </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
          </li>
        })}
      </ul>}
    </SettingsPanel>
    {selection?.action === 'rename' && <RenameRetainedWorkspace workspace={selection.workspace} onClose={closeDialog} onChanged={refresh} onError={onError} />}
    {selection?.action === 'delete' && <DeleteRetainedWorkspace workspace={selection.workspace} onClose={closeDialog} onChanged={refresh} onError={onError} onConfirm={cleanup.remove} />}
  </div>
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
