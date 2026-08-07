import { useMemo, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Folder,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Settings,
  Trash2,
} from 'lucide-react'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { SessionListItem } from '../../shared/session.ts'
import { workspaceDisplayDirectory } from '../../shared/workspace.ts'

interface AppSidebarProps {
  collapsed: boolean
  sessions: readonly SessionListItem[]
  error: string | null
  actionError: string | null
  busy: boolean
  deletingSessionId: string | null
  onCollapsedChange: (collapsed: boolean) => void
  onNewSession: () => void
  onResume: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onOpenSettings: () => void
}

export function AppSidebar(props: AppSidebarProps) {
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const deleteTarget = props.sessions.find((session) => session.sessionId === deleteTargetId)
  const sections = useMemo(() => sessionSections(props.sessions), [props.sessions])

  return (
    <aside
      className={`wc-shell-panel relative z-20 flex h-full shrink-0 flex-col bg-[var(--wc-sidebar)] transition-[width] duration-150 ${
        props.collapsed ? 'w-[62px]' : 'w-[240px]'
      }`}
      aria-label="会话侧栏"
    >
      <div className={`flex h-14 items-center ${props.collapsed ? 'justify-center' : 'justify-between px-2.5'}`}>
        {!props.collapsed && (
          <div className="overflow-hidden whitespace-nowrap text-sm font-semibold tracking-tight">WhyCode</div>
        )}
        <button
          type="button"
          className="wc-icon-button"
          aria-label={props.collapsed ? '展开会话侧栏' : '收起会话侧栏'}
          title={props.collapsed ? '展开侧栏' : '收起侧栏'}
          onClick={() => props.onCollapsedChange(!props.collapsed)}
        >
          {props.collapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
        </button>
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

      {props.collapsed ? (
        <div className="mt-3 flex min-h-0 flex-1 flex-col items-center gap-1 px-2">
          <button
            type="button"
            className="wc-icon-button relative"
            aria-label="展开并查看会话"
            title="会话"
            onClick={() => props.onCollapsedChange(false)}
          >
            <MessageSquare size={17} />
            {props.sessions.some((session) => session.needsAttention) && (
              <span className="absolute right-1 top-1 size-2 rounded-full bg-[#b37b62]" />
            )}
          </button>
        </div>
      ) : (
        <div className="wc-scrollbar mt-4 min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3">
          {props.error && <SidebarError text={props.error} />}
          {props.actionError && <SidebarError text={props.actionError} />}
          {props.sessions.length === 0 && !props.error ? (
            <div className="px-3 py-12 text-center text-xs text-[var(--wc-faint)]">
              新会话会显示在这里
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.label} className="mb-4">
                <h2 className="mb-1 px-2 text-[11px] font-medium tracking-wide text-[var(--wc-faint)]">
                  {section.label}
                </h2>
                <div className="space-y-0.5">
                  {section.sessions.map((session) => (
                    <SessionItem
                      key={session.sessionId}
                      session={session}
                      busy={props.busy}
                      deleting={session.sessionId === props.deletingSessionId}
                      onResume={props.onResume}
                      onRequestDelete={setDeleteTargetId}
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}

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

      <AlertDialog.Root
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => { if (!open) setDeleteTargetId(null) }}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
          <AlertDialog.Content className="wc-dialog-card wc-paper-card wc-paper-rose wc-paper-shape-c wc-paper-pad fixed left-1/2 top-1/2 z-[91] w-[min(92vw,440px)] -translate-x-1/2 -translate-y-1/2 outline-none">
            <div className="mb-3 flex size-9 items-center justify-center rounded-xl bg-[#eee2dc] text-[var(--wc-danger)]">
              <CircleAlert size={18} />
            </div>
            <AlertDialog.Title className="text-base font-semibold">删除这个会话？</AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-6 text-[var(--wc-muted)]">
              {deleteTarget ? deleteDescription(deleteTarget) : ''}
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button className="rounded-xl border border-[var(--wc-line)] bg-white px-3 py-2 text-sm">取消</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className="rounded-xl bg-[var(--wc-danger)] px-3 py-2 text-sm text-white"
                  onClick={() => {
                    if (deleteTarget) props.onDelete(deleteTarget.sessionId)
                    setDeleteTargetId(null)
                  }}
                >
                  删除会话
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </aside>
  )
}

function SessionItem({
  session,
  busy,
  deleting,
  onResume,
  onRequestDelete,
}: {
  session: SessionListItem
  busy: boolean
  deleting: boolean
  onResume: (sessionId: string) => void
  onRequestDelete: (sessionId: string) => void
}) {
  const directory = session.workspace ? workspaceDisplayDirectory(session.workspace) : null
  const selectable = !busy && !session.isCurrent && session.resumable
  return (
    <div
      className={`group flex min-w-0 items-center rounded-xl pr-1 transition-colors ${
        session.isCurrent ? 'bg-white shadow-[1px_2px_0_rgb(43_46_41_/_5%)]' : 'hover:bg-black/[0.045]'
      }`}
    >
      <button
        type="button"
        className="wc-focus-ring min-w-0 flex-1 rounded-xl px-2.5 py-2 text-left"
        disabled={!selectable}
        onClick={() => onResume(session.sessionId)}
        title={session.resumable ? directory ?? undefined : session.unavailableReason}
      >
        <div className="flex items-center gap-2">
          <StatusDot session={session} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {session.title || '未命名会话'}
          </span>
          {deleting && <span className="text-[10px] text-[var(--wc-danger)]">删除中</span>}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 pl-4 text-[10px] text-[var(--wc-faint)]">
          {directory && <Folder size={11} className="shrink-0" />}
          <span className="min-w-0 flex-1 truncate">{directory ? lastPathSegment(directory) : statusLabel(session.status)}</span>
          <time className="shrink-0">{relativeTime(session.updatedAt)}</time>
        </div>
      </button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="wc-icon-button size-7 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100"
            disabled={busy || session.running}
            aria-label={`管理会话 ${session.title || '未命名会话'}`}
          >
            <MoreHorizontal size={15} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="wc-menu-content" sideOffset={5} align="end">
            <DropdownMenu.Item
              className="wc-menu-item text-[var(--wc-danger)]"
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

function StatusDot({ session }: { session: SessionListItem }) {
  const className = session.needsAttention
    ? 'bg-[#b37b62]'
    : session.running
      ? 'bg-[#738b76]'
      : session.isCurrent
        ? 'bg-[#7b8790]'
        : 'bg-[#c5c6c0]'
  return <span className={`size-2 shrink-0 rounded-full ${className}`} aria-hidden="true" />
}

function SidebarError({ text }: { text: string }) {
  return (
    <p className="mx-1 mb-3 rounded-xl bg-[#eee2dc] px-3 py-2 text-xs text-[#8a514e]" role="alert">
      {text}
    </p>
  )
}

function sessionSections(sessions: readonly SessionListItem[]) {
  const active = sessions.filter((session) => session.running || session.needsAttention)
  const activeIds = new Set(active.map((session) => session.sessionId))
  const recent = sessions.filter((session) => !activeIds.has(session.sessionId))
  return [
    ...(active.length > 0 ? [{ label: '进行中', sessions: active }] : []),
    ...(recent.length > 0 ? [{ label: '最近', sessions: recent }] : []),
  ]
}

function deleteDescription(session: SessionListItem): string {
  if (session.workspace?.mode === 'worktree') {
    return '会话及其受管 Worktree 会被永久删除，尚未提交的文件变化会丢失；已经创建的 Git 分支及其提交仍保留。'
  }
  if (session.workspace?.mode === 'managed') {
    return '会话、任务状态、检查点、后台命令记录和这个会话专属默认工作目录中的全部文件都会被永久删除。'
  }
  return '会话、任务状态、检查点、后台命令记录和临时数据都会被永久删除；本地工作文件夹保持不变。'
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

function statusLabel(status: SessionListItem['status']): string {
  if (status === 'unavailable') return '当前不可恢复'
  if (status === 'interrupted') return '上次意外中断'
  if (status === 'waiting-user') return '等待你的回答'
  if (status === 'paused') return '已安全暂停'
  if (status === 'max-turns') return '可继续'
  if (status === 'running') return '运行中'
  return '可恢复'
}
