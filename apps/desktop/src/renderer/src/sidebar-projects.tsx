import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { MAX_PROJECT_NAME_LENGTH, type SidebarProject } from '../../shared/projects.ts'
import { NameEditorDialog } from './name-editor.tsx'

interface SidebarProjectsProps {
  projects: readonly SidebarProject[]
  selectedSessionId: string | null
  busy: boolean
  onSelect: (projectId?: string) => void
  onRename: (id: string, name: string) => Promise<boolean>
  onRemove: (id: string) => void
  renderSessions: (project: SidebarProject) => ReactNode
}

export function SidebarProjects(props: SidebarProjectsProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [renameId, setRenameId] = useState<string | null>(null)
  const renamed = props.projects.find(project => project.id === renameId)
  return <section className="mb-4" aria-label="项目">
    <div className="group/projects mb-1 flex h-7 items-center gap-1 px-2">
      <button type="button" className="wc-focus-ring flex min-w-0 items-center gap-1 rounded-md wc-type-caption font-medium text-[var(--wc-faint)] hover:text-[var(--wc-muted)]"
        aria-expanded={!collapsed} aria-label={collapsed ? '展开项目' : '收起项目'} onClick={() => setCollapsed(value => !value)}>
        <span>项目</span><ChevronDown size={12} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>
      <button type="button" className="wc-icon-button ml-auto size-6 opacity-0 group-hover/projects:opacity-100 focus-visible:opacity-100"
        aria-label="添加项目" title="添加项目" disabled={props.busy}
        onClick={() => { setCollapsed(false); props.onSelect() }}><Plus size={15} /></button>
    </div>
    {!collapsed && (props.projects.length ? <div className="space-y-1">
      {props.projects.map(project => <ProjectGroup key={project.id} project={project} selectedSessionId={props.selectedSessionId}
        busy={props.busy} onSelect={props.onSelect} onRename={() => setRenameId(project.id)} onRemove={props.onRemove}>
        {props.renderSessions(project)}
      </ProjectGroup>)}
    </div> : <p className="px-2 py-2 wc-type-caption text-[var(--wc-faint)]">没有项目</p>)}
    {renamed && <NameEditorDialog key={renamed.id} id={renamed.id} title={renamed.name} label="项目"
      description="只更改显示名称，文件夹路径保持不变。" maxLength={MAX_PROJECT_NAME_LENGTH}
      onRename={props.onRename} onClose={() => setRenameId(null)} />}
  </section>
}

function ProjectGroup({ project, selectedSessionId, busy, onSelect, onRename, onRemove, children }: {
  project: SidebarProject; selectedSessionId: string | null; busy: boolean
  onSelect: (id: string) => void; onRename: () => void; onRemove: (id: string) => void; children: ReactNode
}) {
  const [expanded, setExpanded] = useState(true)
  const selected = selectedSessionId !== null && project.sessionIds.includes(selectedSessionId)
  useEffect(() => { if (selected) setExpanded(true) }, [selected, selectedSessionId])
  return <div>
    <div className="group/project-row flex min-w-0 items-center rounded-lg pr-1 hover:bg-black/[0.045] has-[[data-state=open]]:bg-black/[0.045]">
      <button type="button" className="wc-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left wc-type-control"
        aria-expanded={expanded} title={project.directory} onClick={() => setExpanded(value => !value)}>
        <span className="relative flex size-4 shrink-0 items-center justify-center text-[var(--wc-muted)]" aria-hidden="true">
          <Folder size={15} className="group-hover/project-row:opacity-0 group-focus-within/project-row:opacity-0" />
          <ChevronRight size={14} className={`absolute opacity-0 transition-transform group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 ${expanded ? 'rotate-90' : ''}`} />
        </span>
        <span className="min-w-0 truncate font-medium">{project.name}</span>
      </button>
      <div className="flex shrink-0 items-center opacity-0 group-hover/project-row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
        <button type="button" className="wc-icon-button size-6" aria-label={`在 ${project.name} 中新建会话`} title="新建会话" disabled={busy}
          onClick={() => { setExpanded(true); onSelect(project.id) }}><Plus size={15} /></button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button type="button" className="wc-icon-button size-6" aria-label={`管理项目 ${project.name}`} title="管理项目" disabled={busy}>
            <MoreHorizontal size={15} />
          </button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="wc-menu-content" sideOffset={5} align="end">
            <DropdownMenu.Item className="wc-menu-item" onSelect={onRename}><Pencil size={15} />重命名</DropdownMenu.Item>
            <DropdownMenu.Item className="wc-menu-item text-[var(--wc-danger)]" onSelect={() => onRemove(project.id)}><Trash2 size={15} />移除项目</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
    {expanded && <div className="ml-3 border-l border-[var(--wc-line)] pl-1">{children}</div>}
  </div>
}
