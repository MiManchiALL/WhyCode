import { useCallback, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react'
import { SessionNameDialog, type RenameSession } from './session-name-editor.tsx'
import { SessionDeleteDialog } from './session-delete-dialog.tsx'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { SessionListItem } from '../../shared/session.ts'
import { workspaceDisplayDirectory } from '../../shared/workspace.ts'
import { SidebarToggleIcon } from './sidebar-toggle-icon.tsx'
import { PanelResizeHandle } from './panel-resize-handle.tsx'
import {
  panelWidthExpression,
  SESSION_SIDEBAR_COLLAPSED_WIDTH,
} from './panel-layout.ts'
import type { PanelLayout } from './use-panel-layout.ts'

interface AppSidebarProps {
  layout: PanelLayout
  collapsed: boolean
  sessions: readonly SessionListItem[]
  selectedSessionId: string | null
  error: string | null
  busy: boolean
  navigationLocked: boolean
  deletingSessionId: string | null
  onCollapsedChange: (collapsed: boolean) => void
  onNewSession: () => void
  onResume: (sessionId: string) => void
  onPinnedChange: (sessionId: string, pinned: boolean) => void
  onRename: RenameSession
  onDelete: (sessionId: string, deleteDirectory: boolean) => void
  onError: (message: string) => void
  onOpenSettings: () => void
}

export function AppSidebar(props: AppSidebarProps) {
  const { layout } = props
  const [resizing, setResizing] = useState(false)
  const [renameTargetId, setRenameTargetId] = useState<string | null>(null)
  const renameTarget = props.sessions.find(session => session.sessionId === renameTargetId)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const closeDeleteDialog = useCallback(() => setDeleteTargetId(null), [])
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false)
  const deleteTarget = props.sessions.find((session) => session.sessionId === deleteTargetId)
  const pinnedSessions = useMemo(
    () => props.sessions.filter((session) => session.pinned),
    [props.sessions],
  )
  const recentSessions = useMemo(
    () => props.sessions.filter((session) => !session.pinned),
    [props.sessions],
  )
  const hasUnreadCompletion = props.sessions.some((session) => session.hasUnreadCompletion)

  return (
    <aside
      ref={layout.refs.left}
      className="wc-resizable-panel relative z-20 h-full shrink-0 transition-[width] duration-200 ease-out"
      data-panel-open={!props.collapsed}
      style={{ width: props.collapsed ? SESSION_SIDEBAR_COLLAPSED_WIDTH : panelWidthExpression('left', layout.widths.left) }}
      aria-label="会话侧栏"
    >
      {(!props.collapsed || resizing) && (
        <PanelResizeHandle
          side="left"
          layout={layout}
          onCollapse={() => props.onCollapsedChange(true)}
          onPreviewExpand={(value) => {
            layout.previewExpand('left', value)
            props.onCollapsedChange(false)
          }}
          onResizeActiveChange={setResizing}
        />
      )}
      <div className="wc-shell-panel flex h-full min-w-0 flex-col bg-[var(--wc-sidebar)]">
        <div className="relative h-14 shrink-0">
          <button
            type="button"
            className="wc-icon-button absolute left-3 top-3"
            aria-label={props.collapsed ? '展开会话侧栏' : '收起会话侧栏'}
            title={props.collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={() => props.onCollapsedChange(!props.collapsed)}
          >
            <SidebarToggleIcon side="left" size={17} />
          </button>
          <div
            className={`pointer-events-none absolute left-1/2 top-1/2 whitespace-nowrap text-sm font-semibold tracking-tight transition-[opacity,transform] duration-200 ease-out ${
              props.collapsed
                ? '-translate-x-1/2 -translate-y-1/2 scale-95 opacity-0'
                : '-translate-x-1/2 -translate-y-1/2 scale-100 opacity-100'
            }`}
            aria-hidden={props.collapsed}
          >
            WhyCode
          </div>
        </div>

        <div className="px-2">
          <button
            type="button"
            className="wc-focus-ring relative flex h-10 w-full items-center gap-2 overflow-hidden rounded-xl border border-[var(--wc-line)] bg-white px-3 text-sm shadow-[1px_2px_0_rgb(43_46_41_/_5%)] transition-colors hover:border-[var(--wc-line-strong)]"
            disabled={props.busy}
            onClick={props.onNewSession}
            title="新建会话"
          >
            <Plus className="shrink-0" size={17} />
            <span className="wc-sidebar-label" data-collapsed={props.collapsed}>新会话</span>
          </button>
        </div>

        <div className="relative min-h-0 flex-1">
          <div
            className={`absolute inset-0 flex flex-col items-center gap-1 px-2 pt-3 transition-[opacity,transform] duration-200 ease-out ${
              props.collapsed
                ? 'translate-x-0 opacity-100'
                : 'pointer-events-none -translate-x-2 opacity-0'
            }`}
            aria-hidden={!props.collapsed}
            inert={!props.collapsed}
          >
            <button
              type="button"
              className="wc-icon-button relative"
              aria-label={hasUnreadCompletion ? '展开并查看有新结果的会话' : '展开并查看会话'}
              title="会话"
              onClick={() => props.onCollapsedChange(false)}
            >
              <MessageSquare size={17} />
              {hasUnreadCompletion && (
                <span className="absolute right-1 top-1 size-2 rounded-full bg-[var(--wc-status-running)]" />
              )}
            </button>
          </div>
          <div
            className={`wc-scrollbar absolute inset-0 overflow-x-hidden overflow-y-auto px-2 pb-3 pt-4 transition-[opacity,transform] duration-200 ease-out ${
              props.collapsed
                ? 'pointer-events-none -translate-x-3 opacity-0'
                : 'translate-x-0 opacity-100'
            }`}
            aria-hidden={props.collapsed}
            inert={props.collapsed}
          >
            {props.error && <SidebarError text={props.error} />}
            {props.sessions.length === 0 && !props.error ? (
              <div className="px-3 py-12 text-center text-xs text-[var(--wc-faint)]">
                新会话会显示在这里
              </div>
            ) : (
              <>
                {pinnedSessions.length > 0 && (
                  <section className="mb-4">
                    <div className="group mb-1 flex h-5 items-center px-2">
                      <h2 className="min-w-0 flex-1 whitespace-nowrap wc-type-caption font-medium tracking-wide text-[var(--wc-faint)]">
                        置顶
                      </h2>
                      <button
                        type="button"
                        className="wc-focus-ring flex size-5 items-center justify-center rounded-md text-[var(--wc-faint)] opacity-0 transition-opacity hover:bg-black/[0.045] hover:text-[var(--wc-muted)] focus:opacity-100 group-hover:opacity-100"
                        aria-label={pinnedCollapsed ? '展开置顶会话' : '收起置顶会话'}
                        title={pinnedCollapsed ? '展开置顶会话' : '收起置顶会话'}
                        onClick={() => setPinnedCollapsed((collapsed) => !collapsed)}
                      >
                        {pinnedCollapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
                      </button>
                    </div>
                    {!pinnedCollapsed && (
                      <SessionItems
                        sessions={pinnedSessions}
                        selectedSessionId={props.selectedSessionId}
                        busy={props.busy}
                        navigationLocked={props.navigationLocked}
                        deletingSessionId={props.deletingSessionId}
                        onResume={props.onResume}
                        onPinnedChange={props.onPinnedChange}
                        onRequestDelete={setDeleteTargetId}
                        onRequestRename={setRenameTargetId}
                      />
                    )}
                  </section>
                )}
                {recentSessions.length > 0 && (
                  <section className="mb-4">
                    <h2 className="mb-1 whitespace-nowrap px-2 wc-type-caption font-medium tracking-wide text-[var(--wc-faint)]">
                      最近
                    </h2>
                    <SessionItems
                      sessions={recentSessions}
                      selectedSessionId={props.selectedSessionId}
                      busy={props.busy}
                      navigationLocked={props.navigationLocked}
                      deletingSessionId={props.deletingSessionId}
                      onResume={props.onResume}
                      onPinnedChange={props.onPinnedChange}
                      onRequestDelete={setDeleteTargetId}
                      onRequestRename={setRenameTargetId}
                    />
                  </section>
                )}
              </>
            )}
          </div>
        </div>

        <div className="p-2">
          <button
            type="button"
            className="wc-focus-ring relative flex h-10 w-full items-center gap-2 overflow-hidden rounded-xl px-3 text-sm text-[var(--wc-muted)] transition-colors hover:bg-black/[0.045] hover:text-[var(--wc-ink)]"
            onClick={props.onOpenSettings}
            title="设置"
          >
            <Settings className="shrink-0" size={17} />
            <span className="wc-sidebar-label" data-collapsed={props.collapsed}>设置</span>
          </button>
        </div>

        {renameTarget && <SessionNameDialog key={renameTarget.sessionId} sessionId={renameTarget.sessionId} title={renameTarget.title}
          onRename={props.onRename} onClose={() => setRenameTargetId(null)} />}
        {deleteTarget && <SessionDeleteDialog key={deleteTarget.sessionId} sessionId={deleteTarget.sessionId}
          onClose={closeDeleteDialog} onDelete={props.onDelete} onError={props.onError} />}
      </div>
    </aside>
  )
}

function SessionItems({
  sessions,
  selectedSessionId,
  busy,
  navigationLocked,
  deletingSessionId,
  onResume,
  onPinnedChange,
  onRequestDelete,
  onRequestRename,
}: {
  sessions: readonly SessionListItem[]
  selectedSessionId: string | null
  busy: boolean
  navigationLocked: boolean
  deletingSessionId: string | null
  onResume: (sessionId: string) => void
  onPinnedChange: (sessionId: string, pinned: boolean) => void
  onRequestDelete: (sessionId: string) => void
  onRequestRename: (sessionId: string) => void
}) {
  return (
    <div className="space-y-0.5">
      {sessions.map((session) => (
        <SessionItem
          key={session.sessionId}
          session={session}
          selected={session.sessionId === selectedSessionId}
          busy={busy}
          navigationLocked={navigationLocked}
          deleting={session.sessionId === deletingSessionId}
          onResume={onResume}
          onPinnedChange={onPinnedChange}
          onRequestDelete={onRequestDelete}
          onRequestRename={onRequestRename}
        />
      ))}
    </div>
  )
}

function SessionItem({
  session,
  selected,
  busy,
  navigationLocked,
  deleting,
  onResume,
  onPinnedChange,
  onRequestDelete,
  onRequestRename,
}: {
  session: SessionListItem
  selected: boolean
  busy: boolean
  navigationLocked: boolean
  deleting: boolean
  onResume: (sessionId: string) => void
  onPinnedChange: (sessionId: string, pinned: boolean) => void
  onRequestDelete: (sessionId: string) => void
  onRequestRename: (sessionId: string) => void
}) {
  const directory = session.workspace ? workspaceDisplayDirectory(session.workspace) : null
  const selectable = !navigationLocked && !deleting && !selected && session.resumable
  return (
    <div
      className={`group flex min-w-0 items-center rounded-xl pr-1 ${
        selected ? 'bg-white shadow-[1px_2px_0_rgb(43_46_41_/_5%)]' : 'hover:bg-black/[0.045]'
      }`}
    >
      <button
        type="button"
        className="wc-focus-ring min-w-0 flex-1 rounded-xl px-2.5 py-2 text-left"
        disabled={!selectable}
        onClick={() => onResume(session.sessionId)}
        title={session.resumable ? directory ?? undefined : session.unavailableReason}
        aria-current={selected ? 'page' : undefined}
        aria-label={`${selected ? '当前' : '打开'}会话 ${session.title || '未命名会话'}${
          session.running ? '，运行中' : session.hasUnreadCompletion ? '，有已完成结果待查看' : ''
        }`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <SessionMarker session={session} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate wc-type-control font-medium">
                {session.title || '未命名会话'}
              </span>
              {deleting && <span className="wc-type-tiny text-[var(--wc-danger)]">删除中</span>}
            </div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 wc-type-tiny text-[var(--wc-faint)]">
              {directory && <Folder size={11} className="shrink-0" />}
              <span className="min-w-0 flex-1 truncate">
                {directory ? lastPathSegment(directory) : statusLabel(session)}
              </span>
              <time className="shrink-0">{relativeTime(session.updatedAt)}</time>
            </div>
          </div>
        </div>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="wc-icon-button size-7 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
            disabled={busy || deleting}
            aria-label={`管理会话 ${session.title || '未命名会话'}`}
          >
            <MoreHorizontal size={15} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="wc-menu-content" sideOffset={5} align="end">
            <DropdownMenu.Item
              className="wc-menu-item"
              onSelect={() => onPinnedChange(session.sessionId, !session.pinned)}
            >
              {session.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              {session.pinned ? '取消置顶' : '置顶对话'}
            </DropdownMenu.Item>
            <DropdownMenu.Item className="wc-menu-item" onSelect={() => onRequestRename(session.sessionId)}>
              <Pencil size={15} />重命名
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className="wc-menu-item text-[var(--wc-danger)]"
              disabled={session.running || deleting}
              onSelect={() => onRequestDelete(session.sessionId)}
            >
              <Trash2 size={15} />
              删除会话
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  )
}

const SESSION_ACTIVITY_CELLS: readonly (readonly [number, number])[] = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
]

function SessionMarker({ session }: { session: SessionListItem }) {
  return (
    <span className="flex size-2.5 shrink-0 items-center justify-center" aria-hidden="true">
      {session.running ? (
        <svg
          className="wc-session-running-indicator"
          width="10"
          height="10"
          viewBox="0 0 10 10"
          shapeRendering="crispEdges"
        >
          {SESSION_ACTIVITY_CELLS.map(([x, y], index) => (
            <rect
              key={`${x}-${y}`}
              className="wc-session-running-cell"
              x={x}
              y={y}
              width="2"
              height="2"
              style={{ animationDelay: `${(index - SESSION_ACTIVITY_CELLS.length) * 125}ms` }}
            />
          ))}
        </svg>
      ) : session.hasUnreadCompletion ? (
        <span className="size-2 rounded-full bg-[var(--wc-status-running)]" />
      ) : null}
    </span>
  )
}

function SidebarError({ text }: { text: string }) {
  return (
    <p className="mx-1 mb-3 rounded-xl bg-[#eee2dc] px-3 py-2 text-xs text-[#8a514e]" role="alert">
      {text}
    </p>
  )
}

function lastPathSegment(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '')
  return normalized.split(/[\\/]/u).at(-1) || path
}

function relativeTime(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(elapsed) || elapsed < 0) return new Date(value).toLocaleDateString()
  if (elapsed < 60_000) return '刚刚'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时`
  return new Date(value).toLocaleDateString()
}

function statusLabel(session: SessionListItem): string {
  if (session.running) return '运行中'
  const { status } = session
  if (status === 'unavailable') return '当前不可恢复'
  if (status === 'interrupted') return '上次意外中断'
  if (status === 'waiting-user') return '等待你的回答'
  if (status === 'paused') return '已安全暂停'
  if (status === 'max-turns') return '可继续'
  if (status === 'running') return '运行中'
  return '可恢复'
}
