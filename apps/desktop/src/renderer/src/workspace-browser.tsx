import { File, FileCode2, FileImage, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { documentFormat, MAX_PREVIEW_VIEWS, type DirectoryEntry } from '../../shared/workspace-files.ts'
import { FilePreviewToolbar } from './file-preview-controls.tsx'
import { useWorkspaceFile } from './use-workspace-file.ts'
import { useScrollArea } from './use-scroll-area.ts'

interface BrowserProps {
  runtimeId: string
  rootPath: string
  expanded: readonly string[]
  refreshRevision: string
  onExpandedChange: (expanded: string[]) => void
  onOpenFile: (path: string, name: string) => void
}

export function WorkspaceBrowser(props: BrowserProps) {
  const [refresh, setRefresh] = useState(0)
  const { ref, onScroll, overscrollBehaviorY } = useScrollArea(props.expanded)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilePreviewToolbar path={props.rootPath}>
        <button type="button" className="wc-preview-action" title="刷新目录" aria-label="刷新目录" onClick={() => setRefresh(value => value + 1)}><RefreshCw size={15} /></button>
      </FilePreviewToolbar>
      <div ref={ref} onScroll={onScroll} style={{ overscrollBehaviorY }} className="wc-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="当前工作路径内容">
        <ul><DirectoryLevel {...props} path="" revision={`${props.refreshRevision}:${refresh}`} /></ul>
      </div>
    </div>
  )
}

function DirectoryLevel(props: BrowserProps & { path: string; revision: string }) {
  const file = useWorkspaceFile(props.runtimeId, 'directory', props.path, props.revision)
  const directory = file.view?.kind === 'directory' ? file.view : null
  return <>
    {!directory && file.loading && <li className="px-2 py-2 text-xs text-[var(--wc-faint)]">正在读取目录…</li>}
    {file.error && <li className="px-2 py-2 text-xs text-[var(--wc-danger)]">{file.error}</li>}
    {directory?.entries.map(entry => <DirectoryRow key={entry.path} {...props} entry={entry} />)}
    {directory && !directory.entries.length && !file.error && <li className="px-2 py-2 text-xs text-[var(--wc-faint)]">{directory.missing ? '当前目录尚未创建，首次使用时会自动创建' : '空文件夹'}</li>}
    {directory && directory.entries.length < directory.total && <li>
      <button type="button" className="wc-focus-ring rounded-md px-2 py-2 text-xs text-[var(--wc-muted)] hover:bg-black/[0.035]" disabled={file.loading}
        onClick={() => void file.refresh(directory.entries.length)}>{file.loading ? '正在读取…' : `显示更多（${directory.entries.length}/${directory.total}）`}</button>
    </li>}
  </>
}

function DirectoryRow(props: BrowserProps & { revision: string; entry: DirectoryEntry }) {
  const { entry } = props
  const expanded = props.expanded.includes(entry.path)
  const isDirectory = entry.kind === 'directory'
  const Icon = isDirectory ? expanded ? FolderOpen : Folder : fileIcon(entry.name)
  const activate = () => {
    if (isDirectory) {
      const paths = expanded ? props.expanded.filter(path => path !== entry.path && !path.startsWith(`${entry.path}/`)) : [...props.expanded, entry.path]
      props.onExpandedChange(paths)
    } else if (entry.kind === 'file') {
      props.onOpenFile(`${props.rootPath.replace(/[\\/]$/u, '')}/${entry.path}`, entry.name)
    }
  }
  return <li className="min-w-0">
    <button type="button" className="wc-focus-ring flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-[var(--wc-ink)] hover:bg-black/[0.035] disabled:text-[var(--wc-faint)]"
      disabled={entry.kind === 'other' || (isDirectory && !expanded && props.expanded.length >= MAX_PREVIEW_VIEWS - 1)} aria-expanded={isDirectory ? expanded : undefined} title={entry.kind === 'other' ? `${entry.name}（链接或特殊文件）` : entry.name} onClick={activate}>
      <Icon size={16} className="shrink-0 text-[var(--wc-muted)]" /><span className="truncate">{entry.name}</span>
    </button>
    {isDirectory && expanded && <ul className="ml-3 border-l border-[var(--wc-line)] pl-1"><DirectoryLevel {...props} path={entry.path} /></ul>}
  </li>
}

function fileIcon(name: string) {
  const format = documentFormat(name)
  if (format === 'image') return FileImage
  if (format === 'html' || format === 'code') return FileCode2
  return File
}
