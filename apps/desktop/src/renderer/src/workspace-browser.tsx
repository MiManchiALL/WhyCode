import { Folder, FolderOpen, MessageSquarePlus, RefreshCw } from 'lucide-react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DirectoryEntry } from '../../shared/workspace-files.ts'
import { fileIcon, FilePreviewToolbar } from './file-preview-controls.tsx'
import { MAX_EXPANDED_WORKSPACE_DIRECTORIES } from './right-panel-state.ts'
import type { WorkspaceDirectories } from './workspace-directories.ts'
import { useScrollArea } from './use-scroll-area.ts'
import { captureWorkspaceBrowserPosition, restoreWorkspaceBrowserPosition, type WorkspaceBrowserPosition } from './workspace-browser-position.ts'
import { pathReferenceText, workspacePathReference, WORKSPACE_PATH_MIME, type PathReference } from './path-reference.ts'

interface BrowserProps {
  runtimeId: string
  directories: WorkspaceDirectories
  rootPath: string
  expanded: readonly string[]
  onExpandedChange: (expanded: string[]) => void
  onOpenFile: (path: string, name: string) => void
  canReferencePath: boolean
  onReferencePath: (runtimeId: string, reference: PathReference) => void
  position?: WorkspaceBrowserPosition
  onPositionChange: (position: WorkspaceBrowserPosition) => void
}

export function WorkspaceBrowser(props: BrowserProps) {
  const { ref, onScroll, overscrollBehaviorY } = useScrollArea(props.expanded)
  const [restoring, setRestoring] = useState(() => props.position?.rootPath === props.rootPath ? props.position : null)
  const pendingPosition = useRef(restoring)
  const savePosition = useRef(props.onPositionChange)
  savePosition.current = props.onPositionChange
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new MutationObserver(restore)
    const release = () => {
      observer.disconnect()
      pendingPosition.current = null
      setRestoring(null)
    }
    function restore() {
      const position = pendingPosition.current
      if (!position || element!.querySelector('[data-directory-loading="true"]')) return
      restoreWorkspaceBrowserPosition(element!, position)
      release()
    }
    if (pendingPosition.current) {
      observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-directory-loading'] })
      restore()
    }
    // 用户开始操作后不再等待迟到目录替他调整位置。
    const interactions = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const
    for (const event of interactions) element.addEventListener(event, release, { passive: true })
    return () => {
      observer.disconnect()
      for (const event of interactions) element.removeEventListener(event, release)
      savePosition.current(pendingPosition.current ?? captureWorkspaceBrowserPosition(element, props.rootPath))
    }
  }, [ref, props.rootPath])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilePreviewToolbar path={props.rootPath}>
        <button type="button" className="wc-preview-action" title="刷新目录" aria-label="刷新目录" onClick={() => props.directories.refresh()}><RefreshCw size={15} /></button>
      </FilePreviewToolbar>
      <div ref={ref} onScroll={onScroll} style={{ overscrollBehaviorY }} className="wc-scrollbar min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="当前工作路径内容">
        <DirectoryLevel {...props} restoring={restoring} path="" />
      </div>
    </div>
  )
}

type DirectoryProps = BrowserProps & { restoring: WorkspaceBrowserPosition | null }

function DirectoryLevel(props: DirectoryProps & { path: string }) {
  const resource = props.directories.get(props.path)
  const file = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  useEffect(() => resource.open(), [resource])
  const directory = file.view?.kind === 'directory' ? file.view : null
  const needsPage = directory && directory.entries.length < Math.min(directory.total, props.restoring?.directories[props.path] ?? 0)
  useEffect(() => {
    if (needsPage && !file.loading && !file.error) void resource.refresh(directory.entries.length)
  }, [needsPage, file.loading, file.error, resource, directory])
  const expandedSibling = directory?.entries.some(entry => entry.kind === 'directory' && props.expanded.includes(entry.path)) ?? false
  return <ul data-directory-path={props.path} data-directory-entries={directory?.entries.length ?? 0}
    data-directory-loading={(!directory && file.loading) || Boolean(needsPage && !file.error)}>
    {!directory && file.loading && <li className="px-2 py-2 text-xs text-[var(--wc-faint)]">正在读取目录…</li>}
    {file.error && <li className="px-2 py-2 text-xs text-[var(--wc-danger)]">{file.error}</li>}
    {directory?.entries.map(entry => <DirectoryRow key={entry.path} {...props} entry={entry} expandedSibling={expandedSibling} />)}
    {directory && !directory.entries.length && !file.error && <li className="px-2 py-2 text-xs text-[var(--wc-faint)]">{directory.missing ? '当前目录尚未创建，首次使用时会自动创建' : '空文件夹'}</li>}
    {directory && directory.entries.length < directory.total && <li>
      <button type="button" className="wc-focus-ring rounded-md px-2 py-2 text-xs text-[var(--wc-muted)] hover:bg-black/[0.035]" disabled={file.loading}
        onClick={() => void resource.refresh(directory.entries.length)}>{file.loading ? '正在读取…' : `显示更多（${directory.entries.length}/${directory.total}）`}</button>
    </li>}
  </ul>
}

function DirectoryRow(props: DirectoryProps & { entry: DirectoryEntry; expandedSibling: boolean }) {
  const { entry } = props
  const expanded = props.expanded.includes(entry.path)
  const isDirectory = entry.kind === 'directory'
  const muted = isDirectory && !expanded && props.expandedSibling
  const Icon = isDirectory ? expanded ? FolderOpen : Folder : fileIcon(entry.name)
  const reference = workspacePathReference(props.rootPath, entry.path, entry.name, isDirectory ? 'directory' : 'file')
  const quoteOnClose = useRef(false)
  const activate = () => {
    if (isDirectory) {
      const paths = expanded ? props.expanded.filter(path => path !== entry.path && !path.startsWith(`${entry.path}/`)) : [...props.expanded, entry.path]
      props.onExpandedChange(paths)
    } else if (entry.kind === 'file') {
      props.onOpenFile(reference.path, entry.name)
    }
  }
  return <li className="min-w-0">
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={entry.kind === 'other'}>
        <button type="button" data-workspace-path={entry.path} draggable={props.canReferencePath && entry.kind !== 'other'}
          onDragStart={event => {
            event.dataTransfer.effectAllowed = 'copy'
            event.dataTransfer.setData(WORKSPACE_PATH_MIME, JSON.stringify({ ...reference, runtimeId: props.runtimeId }))
            event.dataTransfer.setData('text/plain', pathReferenceText(reference))
          }}
          className={`wc-focus-ring flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${muted ? 'text-[var(--wc-faint)]' : 'text-[var(--wc-ink)]'} hover:bg-black/[0.035] disabled:text-[var(--wc-faint)]`}
          disabled={entry.kind === 'other' || (isDirectory && !expanded && props.expanded.length >= MAX_EXPANDED_WORKSPACE_DIRECTORIES)} aria-expanded={isDirectory ? expanded : undefined} title={entry.kind === 'other' ? `${entry.name}（链接或特殊文件）` : entry.name} onClick={activate}>
          <Icon size={16} className={`shrink-0 ${muted ? '' : 'text-[var(--wc-muted)]'}`} /><span className="truncate">{entry.name}</span>
        </button>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="wc-menu-content" data-density="compact" collisionPadding={8}
          onCloseAutoFocus={event => {
            if (!quoteOnClose.current) return
            quoteOnClose.current = false
            event.preventDefault()
            props.onReferencePath(props.runtimeId, reference)
          }}>
          <ContextMenu.Item className="wc-menu-item" disabled={!props.canReferencePath}
            onSelect={() => { quoteOnClose.current = true }}>
            <MessageSquarePlus size={15} /><span>在对话中引用</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
    {isDirectory && expanded && <div className="ml-3 border-l border-[var(--wc-line)] pl-1"><DirectoryLevel {...props} path={entry.path} /></div>}
  </li>
}
