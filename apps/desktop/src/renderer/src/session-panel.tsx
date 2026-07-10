import type { SessionMetadata } from '@whycode/core'
import type { SessionListItem } from '../../shared/session.ts'

interface SessionPanelProps {
  sessions: SessionListItem[]
  busy: boolean
  onClose: () => void
  onResume: (sessionId: string) => void
  onDelete: (sessionId: string) => void
}

export function SessionPanel(props: SessionPanelProps) {
  return (
    <div className="absolute inset-0 z-20 flex bg-black/20" onClick={props.onClose}>
      <aside
        className="h-full w-96 overflow-y-auto border-r border-neutral-200 bg-white p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">会话历史</h2>
          <button className="text-sm text-neutral-400 hover:text-neutral-700" onClick={props.onClose}>
            ✕
          </button>
        </div>
        {props.sessions.length === 0 ? (
          <p className="py-12 text-center text-sm text-neutral-400">还没有可恢复的会话</p>
        ) : (
          <div className="space-y-2">
            {props.sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                busy={props.busy}
                onResume={props.onResume}
                onDelete={props.onDelete}
              />
            ))}
          </div>
        )}
      </aside>
    </div>
  )
}

function SessionRow({
  session,
  busy,
  onResume,
  onDelete,
}: {
  session: SessionListItem
  busy: boolean
  onResume: (sessionId: string) => void
  onDelete: (sessionId: string) => void
}) {
  return (
    <div
      className={
        session.isCurrent
          ? 'rounded border border-blue-500 bg-blue-50/60 p-3 ring-1 ring-blue-200'
          : 'rounded border border-neutral-200 p-3 hover:border-neutral-400'
      }
    >
      <button
        className="w-full text-left"
        disabled={busy || session.isCurrent}
        onClick={() => onResume(session.sessionId)}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {session.title || '未命名会话'}
          </div>
          {session.isCurrent && (
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] text-blue-700">
              当前
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-neutral-400">
          {session.projectDir ?? '纯聊天'}
        </div>
        <div className="mt-1 flex justify-between text-xs text-neutral-400">
          <span>{session.isCurrent ? '当前对话' : statusLabel(session.status)}</span>
          <time>{new Date(session.updatedAt).toLocaleString()}</time>
        </div>
      </button>
      <button
        className="mt-2 text-xs text-red-400 hover:text-red-600 disabled:opacity-40"
        disabled={busy}
        onClick={() => onDelete(session.sessionId)}
      >
        删除
      </button>
    </div>
  )
}

function statusLabel(status: SessionMetadata['status']): string {
  if (status === 'interrupted') return '上次意外中断'
  if (status === 'error') return '上次出错'
  if (status === 'max-turns') return '达到循环上限，可继续'
  if (status === 'running') return '运行中'
  return '可恢复'
}
