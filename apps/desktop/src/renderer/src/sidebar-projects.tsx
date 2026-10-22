import { useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Pencil, Plus, Server, Trash2 } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { MAX_PROJECT_NAME_LENGTH, type SidebarProject } from '../../shared/projects.ts'
import { NameEditorDialog } from './name-editor.tsx'
import { useSidebarGroupCollapsed } from './sidebar-collapse.ts'
import { SettingsButton } from './settings-layout.tsx'

interface SidebarProjectsProps {
  projects: readonly SidebarProject[]
  busy: boolean
  onSelect: (projectId?: string) => void
  onRename: (id: string, name: string) => Promise<boolean>
  onRemove: (id: string) => void
  renderSessions: (project: SidebarProject) => ReactNode
}

export function SidebarProjects(props: SidebarProjectsProps) {
  const [collapsed, setCollapsed] = useSidebarGroupCollapsed('projects')
  const [renameId, setRenameId] = useState<string | null>(null)
  const renamed = props.projects.find(project => project.id === renameId)
  return <section className="mb-4" aria-label="项目">
    <div className="group/projects mb-1 flex h-7 items-center gap-1 px-2">
      <button type="button" className="wc-focus-ring flex min-w-0 items-center gap-1 rounded-md wc-type-caption font-medium text-[var(--wc-faint)] hover:text-[var(--wc-muted)]"
        aria-expanded={!collapsed} aria-label={collapsed ? '展开项目' : '收起项目'} onClick={() => setCollapsed(!collapsed)}>
        <span>项目</span><ChevronDown size={12} className={`transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>
      <button type="button" className="wc-icon-button ml-auto size-6 opacity-0 group-hover/projects:opacity-100 focus-visible:opacity-100"
        aria-label="添加项目" title="添加项目" disabled={props.busy}
        onClick={() => { setCollapsed(false); props.onSelect() }}><Plus size={15} /></button>
    </div>
    {!collapsed && (props.projects.length ? <div className="space-y-1">
      {props.projects.map(project => <ProjectGroup key={project.id} project={project}
        busy={props.busy} onSelect={props.onSelect} onRename={() => setRenameId(project.id)} onRemove={props.onRemove}>
        {props.renderSessions(project)}
      </ProjectGroup>)}
    </div> : <p className="px-2 py-2 wc-type-caption text-[var(--wc-faint)]">没有项目</p>)}
    {renamed && <NameEditorDialog key={renamed.id} id={renamed.id} title={renamed.name} label="项目"
      description="只更改显示名称，文件夹路径保持不变。" maxLength={MAX_PROJECT_NAME_LENGTH}
      onRename={props.onRename} onClose={() => setRenameId(null)} />}
  </section>
}

function ProjectGroup({ project, busy, onSelect, onRename, onRemove, children }: {
  project: SidebarProject; busy: boolean
  onSelect: (id: string) => void; onRename: () => void; onRemove: (id: string) => void; children: ReactNode
}) {
  const [collapsed, setCollapsed] = useSidebarGroupCollapsed(`project:${project.id}`)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const ProjectIcon = project.remote ? Server : Folder
  return <div>
    <div className="group/project-row flex min-w-0 items-center rounded-lg pr-1 hover:bg-black/[0.045] has-[[data-state=open]]:bg-black/[0.045]">
      <button type="button" className="group/project-toggle wc-focus-ring flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left wc-type-control"
        aria-expanded={!collapsed} title={project.remote ? `${project.remote.label} · ${project.directory}` : project.directory} onClick={() => setCollapsed(!collapsed)}>
        <span className="relative flex size-4 shrink-0 items-center justify-center text-[var(--wc-muted)]" aria-hidden="true">
          <ProjectIcon size={15} className="group-hover/project-row:opacity-0 group-focus-visible/project-toggle:opacity-0" />
          <ChevronRight size={14} className={`absolute opacity-0 transition-transform group-hover/project-row:opacity-100 group-focus-visible/project-toggle:opacity-100 ${collapsed ? '' : 'rotate-90'}`} />
        </span>
        {project.remote ? <span className="flex min-w-0 flex-1 items-center gap-1 font-medium">
          <span className="max-w-[calc(50%-0.5rem)] truncate text-[var(--wc-muted)]">{project.remote.label}</span>
          <span aria-hidden="true" className="shrink-0 text-[var(--wc-faint)]">/</span>
          <span className="max-w-[calc(50%-0.5rem)] truncate">{project.name}</span>
        </span> : <span className="min-w-0 truncate font-medium">{project.name}</span>}
      </button>
      <div className="flex shrink-0 items-center opacity-0 group-hover/project-row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
        <button type="button" className="wc-icon-button size-6" aria-label={`在 ${project.name} 中新建会话`} title="新建会话" disabled={busy}
          onClick={() => { setCollapsed(false); onSelect(project.id) }}><Plus size={15} /></button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild><button ref={menuTrigger} type="button" className="wc-icon-button size-6" aria-label={`管理项目 ${project.name}`} title="管理项目" disabled={busy}>
            <MoreHorizontal size={15} />
          </button></DropdownMenu.Trigger>
          <DropdownMenu.Portal><DropdownMenu.Content className="wc-menu-content" sideOffset={5} align="end"
            onCloseAutoFocus={event => { if (confirmRemove) event.preventDefault() }}>
            <DropdownMenu.Item className="wc-menu-item" onSelect={onRename}><Pencil size={15} />重命名</DropdownMenu.Item>
            <DropdownMenu.Item className="wc-menu-item text-[var(--wc-danger)]" onSelect={() => {
              if (project.sessionIds.length) setConfirmRemove(true)
              else onRemove(project.id)
            }}><Trash2 size={15} />移除项目</DropdownMenu.Item>
          </DropdownMenu.Content></DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </div>
    {!collapsed && <div className="ml-3 pl-1">{children}</div>}
    <AlertDialog.Root open={confirmRemove} onOpenChange={setConfirmRemove}><AlertDialog.Portal>
      <AlertDialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/20 backdrop-blur-[1px]" />
      <AlertDialog.Content className="wc-dialog-card wc-menu-surface fixed left-1/2 top-1/2 z-[91] max-h-[90vh] w-[min(92vw,460px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-5 outline-none"
        onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}
        onCloseAutoFocus={event => { event.preventDefault(); menuTrigger.current?.focus() }}>
        <AlertDialog.Title className="text-base font-semibold">移除项目？</AlertDialog.Title>
        <p className="mt-2 truncate text-sm font-medium" title={project.name}>{project.name}</p>
        <AlertDialog.Description className="mt-2 text-sm leading-6 text-[var(--wc-muted)]">
          会话将移到“最近”，置顶会话保持不变。
        </AlertDialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <AlertDialog.Cancel asChild><SettingsButton>取消</SettingsButton></AlertDialog.Cancel>
          <AlertDialog.Action asChild><SettingsButton variant="danger" disabled={busy} onClick={() => onRemove(project.id)}>移除项目</SettingsButton></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal></AlertDialog.Root>
  </div>
}
