import { Folder, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { SessionListItem } from '../../shared/session.ts'
import { workspaceDisplayDirectory } from '../../shared/workspace.ts'
import { fileName } from './local-files.ts'

export function SessionItems({
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
                {directory ? fileName(directory) : statusLabel(session)}
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
