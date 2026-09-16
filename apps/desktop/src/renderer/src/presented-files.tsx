import type { PresentedFile } from '@whycode/core/presentation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowUpRight, ChevronDown, ChevronUp, Copy, ExternalLink, FolderOpen, LoaderCircle, MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { documentFormat } from '../../shared/workspace-files.ts'
import type { RightPanelPage } from './right-panel-state.ts'
import { fileIcon } from './file-preview-controls.tsx'
import { fileName } from './local-files.ts'
import { performWorkspaceFileAction, type WorkspaceFileAction } from './workspace-file-actions.ts'

type OpenFile = (page: Extract<RightPanelPage, { kind: 'file' }>) => void

export function PresentedFiles({ files, runtimeId, onOpenFile }: {
  files: readonly PresentedFile[]; runtimeId: string; onOpenFile?: OpenFile
}) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? files : files.slice(0, 4)
  return <div className="wc-present-files">
    <div className="wc-present-grid" data-single={files.length === 1 || undefined}>
      {visible.map(file => <PresentedFileCard key={file.path} file={file} runtimeId={runtimeId} onOpenFile={onOpenFile} />)}
    </div>
    {files.length > 4 && <button type="button" className="wc-present-toggle wc-focus-ring wc-type-caption"
      aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起文件' : `查看全部 ${files.length} 个文件`}
      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>}
  </div>
}

function PresentedFileCard({ file, runtimeId, onOpenFile }: {
  file: PresentedFile; runtimeId: string; onOpenFile?: OpenFile
}) {
  const name = fileName(file.path)
  const Icon = fileIcon(name)
  const previewable = documentFormat(file.path) !== 'unsupported'
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [runtimeId, file.path])
  const nativeAction = async (action: WorkspaceFileAction) => {
    if (request.current) return
    const abort = new AbortController()
    request.current = abort
    setPending(true)
    setError(null)
    try {
      await performWorkspaceFileAction(window.whycode, runtimeId, file.path, action, abort.signal)
    } catch (error) {
      if (!abort.signal.aborted) setError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!abort.signal.aborted) { request.current = null; setPending(false) }
    }
  }
  const open = () => {
    if (previewable) onOpenFile?.({ kind: 'file', path: file.path, name, source: { kind: 'current' } })
    else void nativeAction('open')
  }
  return <div className="wc-present-card">
    <button type="button" className="wc-present-open wc-focus-ring" title={file.path}
      aria-label={`${previewable ? '预览' : '打开'} ${name}`}
      disabled={pending || (previewable && !onOpenFile)} onClick={open}>
      <span className="wc-present-icon"><Icon size={20} aria-hidden="true" /></span>
      <span className="wc-present-label">
        <span className="wc-present-name wc-type-control">{name}</span>
        <span className="wc-present-description wc-type-caption" role={error ? 'alert' : undefined} title={error ?? file.description}
          data-error={!!error || undefined}>
          {error ?? file.description ?? (name.includes('.') ? name.split('.').at(-1)!.toUpperCase() : '文件')}
        </span>
      </span>
      {pending ? <LoaderCircle size={15} className="shrink-0 animate-spin" /> : <ArrowUpRight size={15} className="wc-present-arrow" />}
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="wc-present-more wc-focus-ring" disabled={pending} aria-label={`${name} 的更多操作`}>
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="wc-menu-content" align="end" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Item className="wc-menu-item" onSelect={() => void nativeAction('open')}><ExternalLink size={14} />用默认应用打开</DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" onSelect={() => void nativeAction('reveal')}><FolderOpen size={14} />在文件夹中显示</DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" onSelect={() => void navigator.clipboard.writeText(file.path).catch(() => undefined)}><Copy size={14} />复制路径</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>
}
