import type { PresentedFile } from '@whycode/core/presentation'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronDown, ChevronUp, Copy, Download, ExternalLink, FolderOpen, LoaderCircle, MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import type { RightPanelPage } from './right-panel-state.ts'
import { fileIcon } from './file-preview-controls.tsx'
import { fileName } from './local-files.ts'
import { useWorkspaceFileAction } from './use-workspace-file-action.ts'

type OpenFile = (page: Extract<RightPanelPage, { kind: 'file' }>) => void

export function PresentedFiles({ files, runtimeId, remote, onOpenFile }: {
  files: readonly PresentedFile[]; runtimeId: string; remote?: boolean; onOpenFile?: OpenFile
}) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? files : files.slice(0, 4)
  return <div className="wc-present-files">
    <div className="wc-present-grid" data-single={files.length === 1 || undefined}>
      {visible.map(file => <PresentedFileCard key={file.path} file={file} runtimeId={runtimeId} remote={remote} onOpenFile={onOpenFile} />)}
    </div>
    {files.length > 4 && <button type="button" className="wc-present-toggle wc-focus-ring wc-type-caption"
      aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? '收起文件' : `查看全部 ${files.length} 个文件`}
      {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
    </button>}
  </div>
}

function PresentedFileCard({ file, runtimeId, remote, onOpenFile }: {
  file: PresentedFile; runtimeId: string; remote?: boolean; onOpenFile?: OpenFile
}) {
  const name = fileName(file.path)
  const Icon = fileIcon(name)
  const { pending, run: nativeAction } = useWorkspaceFileAction(runtimeId, file.path)
  const open = () => {
    onOpenFile?.({ kind: 'file', path: file.path, name, source: { kind: 'current' }, previewMode: 'preview' })
  }
  return <div className="wc-present-card">
    <button type="button" className="wc-present-open wc-focus-ring" title={file.path}
      aria-label={`预览 ${name}`}
      disabled={pending || !onOpenFile} onClick={open}>
      <span className="wc-present-icon"><Icon size={20} aria-hidden="true" /></span>
      <span className="wc-present-label">
        <span className="wc-present-name wc-type-control">{name}</span>
        <span className="wc-present-description wc-type-caption" title={file.description}>
          {file.description ?? (name.includes('.') ? name.split('.').at(-1)!.toUpperCase() : '文件')}
        </span>
      </span>
      {pending && <LoaderCircle size={15} className="shrink-0 animate-spin" />}
    </button>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="wc-present-more wc-focus-ring" disabled={pending} aria-label={`${name} 的更多操作`}>
          <MoreHorizontal size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="wc-menu-content" align="end" sideOffset={6} collisionPadding={8}>
          {!remote && <>
            <DropdownMenu.Item className="wc-menu-item" onSelect={() => void nativeAction('open')}><ExternalLink size={14} />用默认应用打开</DropdownMenu.Item>
            <DropdownMenu.Item className="wc-menu-item" onSelect={() => void nativeAction('reveal')}><FolderOpen size={14} />在文件夹中显示</DropdownMenu.Item>
          </>}
          <DropdownMenu.Item className="wc-menu-item" onSelect={() => void nativeAction('save')}><Download size={14} />保存到本机</DropdownMenu.Item>
          <DropdownMenu.Item className="wc-menu-item" onSelect={() => void navigator.clipboard.writeText(file.path).catch(() => undefined)}><Copy size={14} />复制路径</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </div>
}
