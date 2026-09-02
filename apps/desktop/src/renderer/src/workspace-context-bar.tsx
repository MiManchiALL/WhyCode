import { Folder, X } from 'lucide-react'
import type {
  RuntimeWorkspace,
  WorkspaceCandidate,
} from '../../shared/workspace.ts'
import {
  WorkspaceStartControls,
  type WorkspaceStartChoice,
} from './workspace-start-controls.tsx'

interface WorkspaceContextBarProps {
  workspace: RuntimeWorkspace
  candidate: WorkspaceCandidate | null
  projectDir: string | null
  baseRef: string | null
  busy: boolean
  canChangeWorkspace: boolean
  onPickProject: () => void
  onClearProject: () => void
  onStart: (choice: WorkspaceStartChoice) => void
}

export function WorkspaceContextBar(props: WorkspaceContextBarProps) {
  const projectSelected = props.workspace.mode !== 'pending-managed' && Boolean(props.projectDir)
  return (
    <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-1.5 rounded-xl bg-black/[0.035] px-2 py-1.5">
      {projectSelected && props.projectDir ? (
        <div className={`flex min-w-0 max-w-[22rem] items-center rounded-lg wc-type-tiny text-[var(--wc-muted)] ${
          props.canChangeWorkspace
            ? 'group/project transition-colors hover:bg-white/70 hover:text-[var(--wc-ink)]'
            : ''
        }`}>
          {props.canChangeWorkspace ? (
            <button
              type="button"
              className="wc-focus-ring flex size-6 shrink-0 items-center justify-center rounded-full"
              disabled={props.busy}
              onClick={props.onClearProject}
              aria-label="移除当前项目"
              title="移除当前项目"
            >
              <Folder size={14} className="group-hover/project:hidden" />
              <span className="hidden size-3.5 items-center justify-center rounded-full bg-[var(--wc-faint)] text-white group-hover/project:flex">
                <X size={9} strokeWidth={2.5} />
              </span>
            </button>
          ) : (
            <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <Folder size={14} />
            </span>
          )}
          {props.canChangeWorkspace ? (
            <button
              type="button"
              className="wc-focus-ring min-w-0 truncate rounded-lg py-1 pl-0.5 pr-1.5 text-left"
              disabled={props.busy}
              onClick={props.onPickProject}
              title={`更改项目：${props.projectDir}`}
            >
              {lastPathSegment(props.projectDir)}
            </button>
          ) : (
            <span
              className="min-w-0 truncate py-1 pl-0.5 pr-1.5"
              title={props.projectDir}
            >
              {lastPathSegment(props.projectDir)}
            </span>
          )}
        </div>
      ) : (
        <button
          type="button"
          className="wc-focus-ring flex min-w-0 max-w-[22rem] items-center gap-1.5 rounded-lg px-1.5 py-1 wc-type-tiny text-[var(--wc-muted)] hover:bg-white/70 hover:text-[var(--wc-ink)] disabled:cursor-default disabled:opacity-60"
          disabled={props.busy || !props.canChangeWorkspace}
          onClick={props.onPickProject}
          title="选择项目；Git 仓库可继续选择 Local 或 Worktree"
        >
          <Folder size={14} className="shrink-0" />
          <span className="truncate">选择项目</span>
        </button>
      )}

      {props.canChangeWorkspace && projectSelected && props.candidate?.repositoryDirectory && (
        <WorkspaceStartControls
          candidate={props.candidate}
          mode={props.workspace.mode}
          baseRef={props.baseRef}
          busy={props.busy}
          onStart={props.onStart}
        />
      )}
    </div>
  )
}

function lastPathSegment(path: string): string {
  const normalized = path.replace(/[\\/]+$/u, '')
  return normalized.split(/[\\/]/u).at(-1) || path
}
