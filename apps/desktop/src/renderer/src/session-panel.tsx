import { useState } from 'react'
import type { SessionMetadata } from '@whycode/core'
import type { SessionListItem } from '../../shared/session.ts'
import { workspaceDisplayDirectory } from '../../shared/workspace.ts'

interface SessionPanelProps {
  sessions: SessionListItem[]
  error: string | null
  actionError: string | null
  busy: boolean
  deletingSessionId: string | null
  resumingSessionId: string | null
  onClose: () => void
  onResume: (sessionId: string) => void
  onDelete: (sessionId: string) => void
}

export function SessionPanel(props: SessionPanelProps) {
  // Windows 上 Electron 原生 confirm 会破坏表单焦点；确认始终留在 Renderer DOM 内。
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null)

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
        {props.error && (
          <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700">
            {props.error}
          </p>
        )}
        {props.actionError && (
          <p className="mb-3 rounded bg-red-50 px-3 py-2 text-xs text-red-700" role="alert">
            {props.actionError}
          </p>
        )}
        {props.resumingSessionId && (
          <p className="mb-3 rounded bg-blue-50 px-3 py-2 text-xs text-blue-700" role="status">
            正在验证附件并恢复会话…
          </p>
        )}
        {props.sessions.length === 0 ? (
          <p className="py-12 text-center text-sm text-neutral-400">
            {props.error ? '暂时无法读取会话列表' : '还没有会话'}
          </p>
        ) : (
          <div className="space-y-2">
            {props.sessions.map((session) => (
              <SessionRow
                key={session.sessionId}
                session={session}
                busy={props.busy}
                deleting={session.sessionId === props.deletingSessionId}
                restoring={session.sessionId === props.resumingSessionId}
                confirmingDelete={session.sessionId === deleteConfirmationId}
                onResume={props.onResume}
                onDelete={props.onDelete}
                onDeleteConfirmationChange={setDeleteConfirmationId}
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
  deleting,
  restoring,
  confirmingDelete,
  onResume,
  onDelete,
  onDeleteConfirmationChange,
}: {
  session: SessionListItem
  busy: boolean
  deleting: boolean
  restoring: boolean
  confirmingDelete: boolean
  onResume: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onDeleteConfirmationChange: (sessionId: string | null) => void
}) {
  return (
    <div
      title={session.resumable ? undefined : session.unavailableReason}
      className={
        session.isCurrent
          ? 'rounded border border-blue-500 bg-blue-50/60 p-3 ring-1 ring-blue-200'
          : 'rounded border border-neutral-200 p-3 hover:border-neutral-400'
      }
    >
      <button
        className="w-full text-left"
        disabled={busy || session.isCurrent || !session.resumable}
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
          {session.running && !session.isCurrent && (
            <span className="shrink-0 rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-700">
              后台运行
            </span>
          )}
          {session.needsAttention && (
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">
              等待操作
            </span>
          )}
          {session.workspace?.mode === 'worktree' && (
            <span className="shrink-0 rounded bg-violet-100 px-1.5 py-0.5 text-[11px] text-violet-700">
              Worktree
            </span>
          )}
          {session.workspace?.mode === 'managed' && (
            <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[11px] text-blue-600">
              默认
            </span>
          )}
          {restoring && (
            <span className="shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-[11px] text-blue-700">
              恢复中
            </span>
          )}
          {deleting && (
            <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">
              删除中
            </span>
          )}
          {!session.resumable && (
            <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] text-amber-700">
              仅可删除
            </span>
          )}
        </div>
        <div className="mt-1 truncate text-xs text-neutral-400">
          {session.workspace
            ? (workspaceDisplayDirectory(session.workspace) ?? '未记录工作文件夹')
            : '工作文件夹未知'}
        </div>
        <div className="mt-1 flex justify-between text-xs text-neutral-400">
          <span className="min-w-0 truncate">
            {session.isCurrent
              ? '当前对话'
              : session.running
                ? runtimeStatusLabel(session.runtimeStatus)
                : session.resumable
                  ? statusLabel(session.status)
                  : session.unavailableReason}
          </span>
          <time className="ml-2 shrink-0">{new Date(session.updatedAt).toLocaleString()}</time>
        </div>
      </button>
      {confirmingDelete ? (
        <div className="mt-3 rounded bg-red-50 p-2 text-xs text-red-700" role="alert">
          <p>
            {session.workspace?.mode === 'worktree'
              ? '将永久删除对话及其关联数据，并丢弃受管 Worktree 中尚未提交的文件变化；未创建分支的 detached 提交也会失去 Worktree 引用，已创建分支及其提交仍保留。'
              : session.workspace?.mode === 'managed'
                ? '将永久删除对话、任务状态、检查点、后台命令记录，以及这个对话专属默认工作目录中的全部文件。'
                : '将永久删除对话、任务状态、检查点、后台命令记录和临时数据；本地工作文件夹不受影响。'}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="rounded bg-red-600 px-2 py-1 text-white disabled:opacity-40"
              disabled={busy || session.running}
              onClick={() => {
                onDeleteConfirmationChange(null)
                onDelete(session.sessionId)
              }}
            >
              确认删除
            </button>
            <button
              className="rounded border border-red-200 bg-white px-2 py-1 text-red-600"
              onClick={() => onDeleteConfirmationChange(null)}
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          className="mt-2 text-xs text-red-400 hover:text-red-600 disabled:opacity-40"
          disabled={busy || session.running}
          onClick={() => onDeleteConfirmationChange(session.sessionId)}
        >
          删除
        </button>
      )}
    </div>
  )
}

function runtimeStatusLabel(status: SessionListItem['runtimeStatus']): string {
  if (status === 'waiting-approval') return '等待你的审批'
  if (status === 'thinking') return '后台思考中'
  if (status === 'working') return '后台执行中'
  if (status === 'error') return '后台任务出错'
  return '后台任务运行中'
}

function statusLabel(status: SessionMetadata['status']): string {
  if (status === 'interrupted') return '上次意外中断'
  if (status === 'waiting-user') return '等待你的回答'
  if (status === 'paused') return '已安全暂停，可继续'
  if (status === 'max-turns') return '达到循环上限，可继续'
  if (status === 'running') return '运行中'
  return '可恢复'
}
