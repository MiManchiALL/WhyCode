import { useCallback, useMemo, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  MessageSquare,
  Plus,
  Settings,
} from 'lucide-react'
import { SessionNameDialog, type RenameSession } from './session-name-editor.tsx'
import { SessionDeleteDialog } from './session-delete-dialog.tsx'
import type { SessionListItem } from '../../shared/session.ts'
import { SessionItems } from './sidebar-sessions.tsx'
import { SidebarProjects } from './sidebar-projects.tsx'
import { groupSidebarSessions } from './sidebar-groups.ts'
import type { SidebarProject } from '../../shared/projects.ts'
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
  projects: readonly SidebarProject[]
  selectedSessionId: string | null
  error: string | null
  busy: boolean
  navigationLocked: boolean
  deletingSessionId: string | null
  onCollapsedChange: (collapsed: boolean) => void
  onNewSession: () => void
  onSelectProject: (id?: string) => void
  onRenameProject: (id: string, name: string) => Promise<boolean>
  onRemoveProject: (id: string) => void
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
  const { pinned: pinnedSessions, recent: recentSessions, byProject } = useMemo(
    () => groupSidebarSessions(props.sessions, props.projects), [props.sessions, props.projects],
  )
  const hasUnreadCompletion = props.sessions.some((session) => session.hasUnreadCompletion)
  const renderSessions = (sessions: readonly SessionListItem[]) => <SessionItems
    sessions={sessions} selectedSessionId={props.selectedSessionId} busy={props.busy}
    navigationLocked={props.navigationLocked} deletingSessionId={props.deletingSessionId}
    onResume={props.onResume} onPinnedChange={props.onPinnedChange}
    onRequestDelete={setDeleteTargetId} onRequestRename={setRenameTargetId} />

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
                  renderSessions(pinnedSessions)
                )}
              </section>
            )}
            <SidebarProjects projects={props.projects} selectedSessionId={props.selectedSessionId}
              busy={props.busy || props.navigationLocked} onSelect={props.onSelectProject}
              onRename={props.onRenameProject} onRemove={props.onRemoveProject}
              renderSessions={project => {
                const items = byProject.get(project.id)!
                return items.length ? renderSessions(items)
                  : <p className="px-3 py-2 wc-type-tiny text-[var(--wc-faint)]">暂无会话</p>
              }} />
            {recentSessions.length > 0 && (
              <section className="mb-4">
                <h2 className="mb-1 whitespace-nowrap px-2 wc-type-caption font-medium tracking-wide text-[var(--wc-faint)]">
                  最近
                </h2>
                {renderSessions(recentSessions)}
              </section>
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

function SidebarError({ text }: { text: string }) {
  return (
    <p className="mx-1 mb-3 rounded-xl bg-[#eee2dc] px-3 py-2 text-xs text-[#8a514e]" role="alert">
      {text}
    </p>
  )
}
