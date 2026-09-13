import type { ReactNode } from 'react'
import type { SkillSummary } from '@whycode/core/skills'
import type { SubagentSummary, TaskPlan } from '@whycode/core'
import {
  ArrowLeftRight,
  Puzzle,
  Bot,
  CheckCircle2,
  ChevronRight,
  GitBranch,
  ListChecks,
  LoaderCircle,
} from 'lucide-react'
import type { RuntimeWorkspace } from '../../shared/workspace.ts'
import { isSubagentRunning } from './subagent-presentation.ts'
import { TaskPlanView } from './task-plan-view.tsx'
import { SKILL_SCOPE_LABEL } from './skill-picker.tsx'
import type { TaskInspectorView } from './right-panel-state.ts'
import { WorktreeEnvironmentMenu } from './worktree-panel.tsx'

interface TaskInspectorProps {
  runtimeId: string
  workspace: RuntimeWorkspace
  plan: TaskPlan | null | undefined
  activeSkills: readonly SkillSummary[]
  view: TaskInspectorView
  onViewChange: (view: TaskInspectorView) => void
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
              <div className="mt-1 truncate font-mono wc-type-tiny text-[var(--wc-muted)]">
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

        <TaskProgressSection key={props.runtimeId} {...props} />
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

function TaskProgressSection({ plan, activeSkills, view, onViewChange }: Pick<
  TaskInspectorProps, 'plan' | 'activeSkills' | 'view' | 'onViewChange'
>) {
  const showingSkills = view === 'skills'
  const switchLabel = showingSkills ? '切换到任务计划' : '切换到当前激活的 Skill'
  return (
    <section className="wc-session-context-section">
      <div className="flex items-center justify-between gap-2">
        <h2 key={view} className="wc-session-context-heading wc-inspector-heading-enter">
          {showingSkills ? <Puzzle size={13} /> : <ListChecks size={13} />}
          <span>{showingSkills ? '当前激活的 Skill' : '任务计划'}</span>
        </h2>
        <button
          type="button"
          className="wc-icon-button size-6 shrink-0"
          title={switchLabel}
          aria-label={switchLabel}
          onClick={() => onViewChange(showingSkills ? 'plan' : 'skills')}
        >
          <ArrowLeftRight size={13} aria-hidden="true" />
        </button>
      </div>
      <div className="mt-1.5 min-h-2">
        <div className="wc-inspector-view" data-active={!showingSkills} aria-hidden={showingSkills} inert={showingSkills}>
          <div className="min-h-0 overflow-hidden">
            {plan && <TaskPlanView key={plan.id} plan={plan} />}
          </div>
        </div>
        <div className="wc-inspector-view" data-active={showingSkills} aria-hidden={!showingSkills} inert={!showingSkills}>
          <div className="min-h-0 overflow-hidden">
            <ActiveSkillList skills={activeSkills} />
          </div>
        </div>
      </div>
    </section>
  )
}

function ActiveSkillList({ skills }: { skills: readonly SkillSummary[] }) {
  return (
    <div className="px-2 pb-1" aria-live="polite" aria-atomic="true">
      {skills.length === 0 ? (
        <p className="text-xs text-[var(--wc-faint)]">当前没有激活的 Skill</p>
      ) : (
        <ul className="space-y-2.5">
          {skills.map((skill) => (
            <li key={skill.id} className="min-w-0" title={skill.path}>
              <div className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate text-[var(--wc-ink)]">{skill.name}</span>
                <span className="shrink-0 wc-type-tiny text-[var(--wc-faint)]">{SKILL_SCOPE_LABEL[skill.scope]}</span>
              </div>
              <p className="mt-0.5 truncate wc-type-caption text-[var(--wc-muted)]">{skill.description}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
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
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 wc-type-caption text-[var(--wc-muted)]">
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
