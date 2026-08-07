import type { TaskPlan, WorktreeWorkspaceBinding } from '@whycode/core'
import { GitBranch, ListChecks } from 'lucide-react'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import { PaperFrame } from './paper-frame.tsx'
import { TaskPlanCard } from './task-plan-card.tsx'
import { WorktreeEnvironmentCard } from './worktree-panel.tsx'

interface TaskInspectorProps {
  runtimeId: string
  workspace: RuntimeWorkspace
  plan: TaskPlan | null | undefined
  busy: boolean
  onPrepareCommitPrompt: () => void
}

export function TaskInspector(props: TaskInspectorProps) {
  const hasEnvironmentCard = props.workspace.mode === 'worktree'
    || props.workspace.mode === 'pending-worktree'

  return (
    <aside
      className="wc-scrollbar ml-3 w-[348px] shrink-0 overflow-y-auto px-4 py-4 max-[1180px]:hidden"
      aria-label="任务信息"
    >
      <div className="wc-paper-stack">
        {props.workspace.mode === 'worktree' && (
          <PaperFrame>
            <WorktreeEnvironmentCard
              runtimeId={props.runtimeId}
              binding={props.workspace as WorktreeWorkspaceBinding}
              busy={props.busy}
              onPrepareCommitPrompt={props.onPrepareCommitPrompt}
            />
          </PaperFrame>
        )}
        {props.workspace.mode === 'pending-worktree' && (
          <PaperFrame>
            <section className="wc-paper-card wc-paper-sage wc-paper-shape-a wc-paper-pad w-full">
              <div className="flex items-start gap-2.5">
                <span className="flex size-7 items-center justify-center rounded-lg bg-white/70 text-[var(--wc-sage-ink)]">
                  <GitBranch size={15} />
                </span>
                <div className="min-w-0">
                  <div className="text-[11px] text-[var(--wc-sage-ink)]/70">环境信息</div>
                  <div className="mt-0.5 text-sm font-medium">Worktree 待创建</div>
                  <div className="mt-1 truncate text-[10px] text-[var(--wc-muted)]">
                    {props.workspace.baseRef ?? 'detached HEAD'}
                  </div>
                </div>
              </div>
            </section>
          </PaperFrame>
        )}
        {props.plan ? (
          <PaperFrame>
            <TaskPlanCard
              key={props.plan.id}
              plan={props.plan}
              compact={hasEnvironmentCard}
            />
          </PaperFrame>
        ) : <EmptyPlanCard />}
      </div>
    </aside>
  )
}

function EmptyPlanCard() {
  return (
    <PaperFrame>
      <section className="wc-paper-card wc-paper-blue wc-paper-shape-b wc-paper-pad min-h-44 w-full">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg bg-white/65 text-[var(--wc-blue-ink)]">
            <ListChecks size={15} />
          </span>
          <div className="text-[11px] font-medium text-[var(--wc-blue-ink)]/75">任务计划</div>
        </div>
      </section>
    </PaperFrame>
  )
}
