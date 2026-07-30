import type { WorkspaceCandidate } from '../../shared/workspace.ts'

interface WorkspaceStartDialogProps {
  candidate: WorkspaceCandidate
  busy: boolean
  onStart: (mode: 'local' | 'worktree') => void
  onPickOther: () => void
  onClose: () => void
}

export function WorkspaceStartDialog(props: WorkspaceStartDialogProps) {
  const worktreeAvailable = Boolean(
    props.candidate.repositoryDirectory
    && props.candidate.baseCommit
    && !props.candidate.worktreeUnavailableReason,
  )
  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/25 p-6"
      onClick={props.onClose}
    >
      <section
        className="w-full max-w-2xl rounded-xl border border-neutral-200 bg-white p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">选择新会话的工作方式</h2>
            <p
              className="mt-1 max-w-xl truncate text-xs text-neutral-500"
              title={props.candidate.selectedDirectory}
            >
              {props.candidate.selectedDirectory}
            </p>
          </div>
          <button
            className="text-sm text-neutral-400 hover:text-neutral-700"
            onClick={props.onClose}
            disabled={props.busy}
          >
            ✕
          </button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            className="rounded-lg border border-neutral-300 p-4 text-left hover:border-neutral-500 disabled:opacity-40"
            onClick={() => props.onStart('local')}
            disabled={props.busy}
          >
            <div className="flex items-center gap-2">
              <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium">
                本地
              </span>
              <strong className="text-sm">直接使用当前目录</strong>
            </div>
            <p className="mt-2 text-xs leading-5 text-neutral-500">
              与其它会话共享同一批文件和长驻进程；同目录写操作仍由宿主串行。
            </p>
          </button>

          <button
            className="rounded-lg border border-violet-300 bg-violet-50/40 p-4 text-left hover:border-violet-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => props.onStart('worktree')}
            disabled={props.busy || !worktreeAvailable}
            title={props.candidate.worktreeUnavailableReason ?? undefined}
          >
            <div className="flex items-center gap-2">
              <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                Worktree
              </span>
              <strong className="text-sm">创建隔离工作区</strong>
            </div>
            <p className="mt-2 text-xs leading-5 text-neutral-500">
              从当前提交创建受管的 detached Worktree；文件、命令、项目指令、MCP
              与检查点全部跟随隔离目录。
            </p>
            {worktreeAvailable ? (
              <p className="mt-2 text-[11px] text-violet-700">
                基线 {props.candidate.baseRef ?? 'detached HEAD'} ·{' '}
                {props.candidate.baseCommit!.slice(0, 10)}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-amber-700">
                {props.candidate.worktreeUnavailableReason}
              </p>
            )}
          </button>
        </div>

        {props.candidate.dirty && worktreeAvailable && (
          <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            当前本地目录检测到未提交更改
            {props.candidate.changedFileCount
              ? `（已列出至少 ${props.candidate.changedFileCount} 项）`
              : ''}。
            隔离 Worktree 只从上面的提交创建，不会静默带入这些改动。
          </p>
        )}
        {worktreeAvailable && (
          <p className="mt-3 text-[11px] leading-5 text-neutral-400">
            如需复制被 Git 忽略的必要文件，可在仓库根目录的
            {' '}<code>.worktreeinclude</code>{' '}中逐行列出明确相对路径；不会复制符号链接或覆盖文件。
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          <button
            className="text-xs text-neutral-500 hover:text-neutral-800 disabled:opacity-40"
            onClick={props.onPickOther}
            disabled={props.busy}
          >
            选择其它文件夹
          </button>
          {props.busy && <span className="text-xs text-violet-600">正在准备工作区…</span>}
        </div>
      </section>
    </div>
  )
}
