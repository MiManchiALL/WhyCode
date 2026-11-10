import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { X, type LucideIcon } from 'lucide-react'

export function ReferenceChip({ name, count, unit = '条', icon: Icon, children }: {
  name: string; count: number; unit?: string; icon: LucideIcon; children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const enter = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 180) }
  const leave = () => { clearTimeout(timer.current); if (!pinned.current) timer.current = setTimeout(() => setOpen(false), 220) }
  const label = `${count} ${unit}${name}`
  return <Popover.Root open={open} onOpenChange={value => { clearTimeout(timer.current); pinned.current = value; setOpen(value) }}>
    <Popover.Trigger asChild><button type="button" className="wc-reference-chip" onPointerEnter={enter} onPointerLeave={leave}
      aria-label={label}
      onClick={event => { event.preventDefault(); clearTimeout(timer.current); pinned.current = !pinned.current || !open; setOpen(pinned.current) }}>
      <Icon size={14} /><span>{label}</span>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="wc-reference-popover wc-reference-list" side="top" align="start" sideOffset={8} collisionPadding={12}
      aria-label={`${name}详情`} onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}
      onFocusCapture={() => { pinned.current = true }} onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => { if (!pinned.current) event.preventDefault() }}>
      <div className="mb-2 flex items-center justify-between text-xs text-[var(--wc-muted)]"><span>{name} · {count}</span>
        <Popover.Close className="wc-preview-action" aria-label="关闭引用详情"><X size={14} /></Popover.Close></div>
      <div className="wc-scrollbar max-h-80 space-y-3 overflow-auto">{children}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
