import type { ReactElement } from 'react'
import { Check, Folder, Plus, Server } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { SidebarProject } from '../../shared/projects.ts'

export function ProjectPicker({ projects, selectedId, onSelect, children }: {
  projects: readonly SidebarProject[]; selectedId?: string; onSelect: (id?: string) => void; children: ReactElement
}) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="wc-menu-content w-72 max-w-[calc(100vw-2rem)]" side="top" align="start" sideOffset={7}>
        <DropdownMenu.Label className="px-2 py-1.5 wc-type-caption text-[var(--wc-faint)]">选择项目</DropdownMenu.Label>
        <div className="wc-scrollbar max-h-64 overflow-y-auto">
          {projects.map(project => <DropdownMenu.Item key={project.id} className="wc-menu-item" title={project.directory}
            onSelect={() => onSelect(project.id)}>
            {project.remote ? <Server size={15} className="shrink-0" /> : <Folder size={15} className="shrink-0" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate">{project.name}</span>
              <span className="block truncate wc-type-tiny text-[var(--wc-faint)]">{project.remote ? `${project.remote.label} · ` : ''}{project.directory}</span>
            </span>
            {project.id === selectedId && <Check size={14} className="shrink-0" />}
          </DropdownMenu.Item>)}
        </div>
        {projects.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-[var(--wc-line)]" />}
        <DropdownMenu.Item className="wc-menu-item" onSelect={() => onSelect()}><Plus size={15} />添加本地项目…</DropdownMenu.Item>
        <DropdownMenu.Item className="wc-menu-item" onSelect={() => onSelect('ssh')}><Server size={15} />添加 SSH 项目…</DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
