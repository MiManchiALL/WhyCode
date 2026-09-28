import { Check, File, FileCode2, FileImage, MoreHorizontal, WrapText, type LucideIcon } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { documentFormat } from '../../shared/workspace-files.ts'
import type { ReactNode } from 'react'

export function FilePreviewToolbar({ path, children }: { path: string; children: ReactNode }) {
  return (
    <div className="wc-file-preview-toolbar flex min-w-0 shrink-0 items-center gap-1 border-b border-[var(--wc-line)] px-3 py-2 text-xs">
      <div className="min-w-0 flex-1 truncate font-mono text-[var(--wc-faint)]" title={path}>{path}</div>
      {children}
    </div>
  )
}

export interface FilePreviewAction {
  label: string
  title?: string
  icon: LucideIcon
  disabled?: boolean
  pending?: boolean
  pressed?: boolean
  marked?: boolean
  run: () => void
}

export function FilePreviewActions({ actions, mode }: {
  actions: readonly FilePreviewAction[]
  mode?: { value: 'preview' | 'code'; disabled: boolean; change: (value: 'preview' | 'code') => void }
}) {
  const modes = [{ value: 'preview', label: '预览' }, { value: 'code', label: '代码' }] as const
  return <>
    <div className="wc-file-preview-actions items-center gap-1">
      {mode && <div className="flex shrink-0 rounded-md bg-black/[0.035] p-0.5" aria-label="文件显示方式">
        {modes.map(item => <button key={item.value} type="button" className="wc-preview-mode"
          aria-pressed={mode.value === item.value} disabled={mode.disabled} onClick={() => mode.change(item.value)}>{item.label}</button>)}
      </div>}
      {actions.map(({ icon: Icon, ...action }) => <button key={action.label} type="button" className="wc-preview-action"
        title={action.title ?? action.label} aria-label={action.label} aria-pressed={action.pressed}
        disabled={action.disabled} aria-busy={action.pending} onClick={action.run}>
        <Icon size={15} />{action.marked && <UpdateMark />}
      </button>)}
    </div>
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild><button type="button" className="wc-preview-action wc-file-preview-menu" title="文件操作" aria-label="文件操作">
        <MoreHorizontal size={16} />{actions.some(action => action.marked) && <UpdateMark />}
      </button></DropdownMenu.Trigger>
      <DropdownMenu.Portal><DropdownMenu.Content className="wc-menu-content" align="end" sideOffset={6} collisionPadding={8}>
        {mode && <>
          <DropdownMenu.RadioGroup value={mode.value} onValueChange={value => mode.change(value as 'preview' | 'code')}>
            {modes.map(item => <DropdownMenu.RadioItem key={item.value} className="wc-menu-item" value={item.value} disabled={mode.disabled}>
              {item.label}<DropdownMenu.ItemIndicator className="ml-auto"><Check size={14} /></DropdownMenu.ItemIndicator>
            </DropdownMenu.RadioItem>)}
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator className="wc-menu-separator" />
        </>}
        {actions.map(({ icon: Icon, ...action }) => <DropdownMenu.Item key={action.label} className="wc-menu-item"
          role={action.pressed === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={action.pressed}
          disabled={action.disabled} onSelect={action.run}>
          <Icon size={14} />{action.label}{action.pressed && <Check size={14} className="ml-auto" />}
        </DropdownMenu.Item>)}
      </DropdownMenu.Content></DropdownMenu.Portal>
    </DropdownMenu.Root>
  </>
}

function UpdateMark() {
  return <span className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-[var(--wc-sage-ink)]" />
}

export function FileWrapButton({ wrap, onChange }: { wrap: boolean; onChange: (wrap: boolean) => void }) {
  return (
    <button type="button" className="wc-preview-action" aria-pressed={wrap}
      title={wrap ? '关闭自动换行' : '开启自动换行'} aria-label="自动换行"
      onClick={() => onChange(!wrap)}>
      <WrapText size={15} />
    </button>
  )
}

export function FilePreviewMessage({ children }: { children: ReactNode }) {
  return <div className="wc-type-caption flex min-h-0 flex-1 items-center justify-center gap-2 px-4 py-8 text-center text-[var(--wc-faint)]">{children}</div>
}

export function fileIcon(name: string) {
  const format = documentFormat(name)
  if (format === 'image') return FileImage
  if (format === 'html' || format === 'code') return FileCode2
  return File
}
