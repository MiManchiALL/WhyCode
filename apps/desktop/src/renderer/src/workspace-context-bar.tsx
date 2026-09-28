import { useEffect, useState } from 'react'
import { Folder, X } from 'lucide-react'
import type { SidebarProject } from '../../shared/projects.ts'
import { ProjectPicker } from './project-picker.tsx'
import { useConversationFeedback } from './conversation-feedback.tsx'
import { fileName, filePathKey } from './local-files.ts'
import {
  workspaceProjectDirectory,
  type RuntimeWorkspace,
  type StartWorkspaceRequest,
  type WorkspaceCandidate,
} from '../../shared/workspace.ts'
import { WorkspaceStartControls } from './workspace-start-controls.tsx'

interface WorkspaceContextBarProps {
  runtimeId: string | null
  workspace: RuntimeWorkspace
  projects: readonly SidebarProject[]
  projectDir: string | null
  baseRef: string | null
  busy: boolean
  canChangeWorkspace: boolean
  onPickProject: (id?: string) => void
  onClearProject: () => void
  onStart: (request: StartWorkspaceRequest) => void
}

export function WorkspaceContextBar(props: WorkspaceContextBarProps) {
  const [candidate, setCandidate] = useState<WorkspaceCandidate | null>(null)
  const feedback = useConversationFeedback()
  const projectSelected = props.workspace.mode !== 'pending-managed' && Boolean(props.projectDir)
  const selectedDirectory = workspaceProjectDirectory(props.workspace)
  const selectedProject = selectedDirectory
    ? props.projects.find(project => props.workspace.mode === 'ssh'
      ? project.remote?.target === props.workspace.target && project.directory === selectedDirectory
      : !project.remote && filePathKey(project.directory) === filePathKey(selectedDirectory))
    : undefined
  useEffect(() => {
    setCandidate(null)
    if (!props.runtimeId || !props.canChangeWorkspace || !selectedDirectory || props.workspace.mode === 'ssh') return
    let active = true
    void window.whycode.inspectDraftWorkspace(props.runtimeId).then(result => {
      if (!active) return
      if (result.ok) setCandidate(result.value)
      else feedback('error', `工作文件夹检查失败：${result.error}`)
    }).catch(error => {
      if (active) feedback('error', `工作文件夹检查失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { active = false }
  }, [props.runtimeId, props.canChangeWorkspace, selectedDirectory, props.workspace.mode, feedback])
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
            <ProjectPicker projects={props.projects} selectedId={selectedProject?.id} onSelect={props.onPickProject}>
              <button
                type="button"
                className="wc-focus-ring min-w-0 truncate rounded-lg py-1 pl-0.5 pr-1.5 text-left"
                disabled={props.busy}
                title={`更改项目：${props.projectDir}`}
              >
                {selectedProject?.name ?? fileName(props.projectDir)}
              </button>
            </ProjectPicker>
          ) : (
            <span
              className="min-w-0 truncate py-1 pl-0.5 pr-1.5"
              title={props.projectDir}
            >
              {fileName(props.projectDir)}
            </span>
          )}
        </div>
      ) : (
        <ProjectPicker projects={props.projects} selectedId={selectedProject?.id} onSelect={props.onPickProject}>
          <button
            type="button"
            className="wc-focus-ring flex min-w-0 max-w-[22rem] items-center gap-1.5 rounded-lg px-1.5 py-1 wc-type-tiny text-[var(--wc-muted)] hover:bg-white/70 hover:text-[var(--wc-ink)] disabled:cursor-default disabled:opacity-60"
            disabled={props.busy || !props.canChangeWorkspace}
            title="选择项目；Git 仓库可继续选择 Local 或 Worktree"
          >
            <Folder size={14} className="shrink-0" />
            <span className="truncate">选择项目</span>
          </button>
        </ProjectPicker>
      )}

      {props.workspace.mode === 'ssh' && <span className="truncate rounded-md bg-black/[0.04] px-2 py-1 text-xs text-[var(--wc-muted)]" title={props.workspace.target}>SSH · {props.workspace.label}</span>}
      {props.canChangeWorkspace && projectSelected && candidate?.repositoryDirectory && (
        <WorkspaceStartControls
          candidate={candidate}
          mode={props.workspace.mode}
          baseRef={props.baseRef}
          busy={props.busy}
          onStart={props.onStart}
        />
      )}
    </div>
  )
}
