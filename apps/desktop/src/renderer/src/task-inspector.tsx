import type { ReactNode } from 'react'
import type { SubagentSummary, TaskPlan } from '@whycode/core'
import {
  Bot,
  CheckCircle2,
  ChevronRight,
  GitBranch,
  ListChecks,
  LoaderCircle,
} from 'lucide-react'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import { isSubagentRunning } from './subagent-presentation.ts'
import { TaskPlanMenu } from './task-plan-menu.tsx'
import { WorktreeEnvironmentMenu } from './worktree-panel.tsx'

interface TaskInspectorProps {
  runtimeId: string
  workspace: RuntimeWorkspace
  plan: TaskPlan | null | undefined
  subagents: readonly SubagentSummary[]
  busy: boolean
  worktreeStatusRevision: number
  onPrepareCommitPrompt: () => void
  onOpenSubagents: () => void
}

export function TaskInspector(props: TaskInspectorProps) {
  return (
    <aside
      className="wc-scrollbar h-full w-full overflow-y-auto px-4 py-4"
      aria-label="会话上下文"
    >
      <div className="wc-menu-content wc-session-context-menu">
        <InspectorSection icon={<GitBranch size={13} />} title="环境信息">
          {props.workspace.mode === 'worktree' && (
            <WorktreeEnvironmentMenu
              key={props.runtimeId}
              runtimeId={props.runtimeId}
              binding={props.workspace}
              busy={props.busy}
              statusRevision={props.worktreeStatusRevision}
              onPrepareCommitPrompt={props.onPrepareCommitPrompt}
            />
          )}
          {props.workspace.mode === 'pending-worktree' && (
            <div className="px-2 pb-1">
              <div className="text-xs font-medium text-[var(--wc-ink)]">
                Worktree 待创建
              </div>
              <div className="mt-1 truncate font-mono text-[10px] text-[var(--wc-muted)]">
                {props.workspace.baseRef ?? 'detached HEAD'}
              </div>
            </div>
          )}
        </InspectorSection>

        <div className="wc-session-context-separator" aria-hidden="true" />

        <InspectorSection icon={<Bot size={13} />} title="子代理">
          <SubagentMenu
            subagents={props.subagents}
            onOpen={props.onOpenSubagents}
          />
        </InspectorSection>

        <div className="wc-session-context-separator" aria-hidden="true" />

        <InspectorSection icon={<ListChecks size={13} />} title="任务计划">
          {props.plan && <TaskPlanMenu key={props.plan.id} plan={props.plan} />}
        </InspectorSection>
      </div>
    </aside>
  )
}

function InspectorSection({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <section className="wc-session-context-section">
      <h2 className="wc-session-context-heading">
        {icon}
        <span>{title}</span>
      </h2>
      <div className="mt-1.5 min-h-2">{children}</div>
    </section>
  )
}

function SubagentMenu({
  subagents,
  onOpen,
}: {
  subagents: readonly SubagentSummary[]
  onOpen: () => void
}) {
  if (subagents.length === 0) return null
  const running = subagents.filter((subagent) => isSubagentRunning(subagent.status)).length
  const completed = subagents.length - running
  return (
    <button
      type="button"
      className="wc-menu-item wc-focus-ring w-full text-left"
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--wc-muted)]">
          {running > 0 && (
            <span className="inline-flex items-center gap-1">
              <LoaderCircle size={11} className="animate-spin" /> {running} 个运行中
            </span>
          )}
          {completed > 0 && (
            <span className="inline-flex items-center gap-1">
              <CheckCircle2 size={11} /> {completed} 个已结束
            </span>
          )}
        </span>
      </span>
      <ChevronRight size={14} className="shrink-0 text-[var(--wc-faint)]" />
    </button>
  )
}
