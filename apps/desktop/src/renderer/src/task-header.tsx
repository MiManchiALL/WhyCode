import { FolderOpen, PanelRight } from 'lucide-react'
import type { BackgroundTaskSummary } from '@whycode/core'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import { BackgroundTaskMenu } from './background-task-menu.tsx'

interface TaskHeaderProps {
  title: string
  projectDir: string | null
  workspaceMode: RuntimeWorkspace['mode']
  backgroundTasks: readonly BackgroundTaskSummary[]
  subagentPanelOpen: boolean
  onOpenWorkspaceFolder: () => void
  onToggleSubagentPanel: () => void
}

export function TaskHeader(props: TaskHeaderProps) {
  const workspaceReady = props.workspaceMode === 'local'
    || props.workspaceMode === 'managed'
    || props.workspaceMode === 'worktree'
    || props.workspaceMode === 'pending-worktree'
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--wc-line)] bg-[var(--wc-surface)] px-4">
      <div className="flex min-w-0 items-center gap-2.5 overflow-hidden">
        <h1 className="max-w-64 truncate text-sm font-semibold tracking-tight" title={props.title}>
          {props.title}
        </h1>
        <span className="h-4 w-px shrink-0 bg-[var(--wc-line)]" />
        <button
          type="button"
          className="wc-focus-ring flex min-w-0 max-w-[min(46vw,560px)] items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-[var(--wc-muted)] hover:bg-black/[0.04] hover:text-[var(--wc-ink)] disabled:cursor-default disabled:hover:bg-transparent"
          onClick={props.onOpenWorkspaceFolder}
          disabled={!workspaceReady || !props.projectDir}
          title={workspaceReady
            ? `打开 ${props.projectDir ?? ''}`
            : '发送首条消息后会创建默认工作目录'}
        >
          <FolderOpen size={14} className="shrink-0" />
          <span className="truncate">{props.projectDir ?? '未选择项目'}</span>
        </button>
        <WorkspaceBadge mode={props.workspaceMode} />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <BackgroundTaskMenu tasks={props.backgroundTasks} />
        <button
          type="button"
          className={`wc-focus-ring flex size-8 items-center justify-center rounded-lg text-[var(--wc-muted)] hover:bg-black/[0.05] hover:text-[var(--wc-ink)] ${props.subagentPanelOpen ? 'bg-black/[0.055] text-[var(--wc-ink)]' : ''}`}
          onClick={props.onToggleSubagentPanel}
          aria-pressed={props.subagentPanelOpen}
          aria-label={props.subagentPanelOpen ? '收起侧边栏' : '展开侧边栏'}
          title={props.subagentPanelOpen ? '收起侧边栏' : '展开侧边栏'}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  )
}

function WorkspaceBadge({ mode }: { mode: RuntimeWorkspace['mode'] }) {
  if (mode === 'worktree') {
    return <span className="shrink-0 rounded-lg bg-[var(--wc-sage)] px-2 py-1 text-[10px] font-medium text-[var(--wc-sage-ink)]">Worktree</span>
  }
  if (mode === 'pending-worktree') {
    return <span className="shrink-0 rounded-lg bg-[var(--wc-sage)] px-2 py-1 text-[10px] text-[var(--wc-sage-ink)]">Worktree · 待创建</span>
  }
  if (mode === 'local') {
    return <span className="shrink-0 rounded-lg bg-black/[0.045] px-2 py-1 text-[10px] text-[var(--wc-muted)]">本地</span>
  }
  if (mode === 'managed') {
    return <span className="shrink-0 rounded-lg bg-[var(--wc-blue)] px-2 py-1 text-[10px] text-[var(--wc-blue-ink)]">默认</span>
  }
  if (mode === 'pending-managed') {
    return <span className="shrink-0 rounded-lg bg-black/[0.045] px-2 py-1 text-[10px] text-[var(--wc-muted)]">未选择</span>
  }
  return null
}
