import { LoaderCircle } from 'lucide-react'

interface WorktreePreparationProps {
  message: string
  baseRef: string | null
}

/** 首条消息已交给宿主，但隔离工作区尚未完成物化时的非虚假进度投影。 */
export function WorktreePreparation(props: WorktreePreparationProps) {
  return (
    <div className="pt-2">
      {props.message && (
        <div className="wc-user-message-copy wc-user-message-bubble ml-auto w-fit max-w-[84%] px-3.5 py-2.5">
          <div className="whitespace-pre-wrap">{props.message}</div>
        </div>
      )}
      <div className="mx-auto mt-[12vh] max-w-lg rounded-2xl border border-[var(--wc-line)] bg-white/70 px-4 py-3.5">
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--wc-ink)]">
          <LoaderCircle size={14} className="animate-spin text-[var(--wc-sage-ink)]" />
          正在创建 Worktree
        </div>
        <p className="mt-2 text-xs leading-5 text-[var(--wc-muted)]">
          正在从 {props.baseRef ?? '所选提交'} 创建隔离工作区并检出文件。完成后会自动开始本次任务。
        </p>
      </div>
    </div>
  )
}
