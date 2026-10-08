import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { MessageSquareText, Pencil, Trash2, X } from 'lucide-react'
import type { BrowserReferenceSource } from '@whycode/core/browser-reference'

export interface BrowserReferenceItem { id: string; previewUrl: string; source: BrowserReferenceSource }

export function BrowserReferenceChip({ items, onRemove, onEdit, onPreview }: {
  items: readonly BrowserReferenceItem[]
  onRemove?: (id: string) => void
  onEdit?: (id: string) => void
  onPreview: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!items.length) return null
  const enter = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 180) }
  const leave = () => { clearTimeout(timer.current); if (!pinned.current) timer.current = setTimeout(() => setOpen(false), 220) }
  return <Popover.Root open={open} onOpenChange={value => { clearTimeout(timer.current); pinned.current = value; setOpen(value) }}>
    <Popover.Trigger asChild><button type="button" className="wc-reference-chip" onPointerEnter={enter} onPointerLeave={leave}
      onClick={event => { event.preventDefault(); clearTimeout(timer.current); pinned.current = !pinned.current || !open; setOpen(pinned.current) }} aria-label={`${items.length} 条网页引用`}>
      <MessageSquareText size={14} /><span>{items.length} 条网页引用</span>
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="wc-reference-popover wc-reference-list" side="top" align="start" sideOffset={8} collisionPadding={12}
      aria-label="网页引用详情" onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}
      onFocusCapture={() => { pinned.current = true }} onOpenAutoFocus={event => event.preventDefault()}
      onCloseAutoFocus={event => { if (!pinned.current) event.preventDefault() }}>
      <div className="mb-2 flex items-center justify-between text-xs text-[var(--wc-muted)]"><span>网页引用 · {items.length}</span>
        <Popover.Close className="wc-preview-action" aria-label="关闭引用详情"><X size={14} /></Popover.Close></div>
      <div className="wc-scrollbar max-h-80 space-y-3 overflow-auto">
        {items.map(item => <div key={item.id} className="min-w-0 border-t border-[var(--wc-line)] pt-2 first:border-0 first:pt-0">
          <div className="flex min-w-0 items-center gap-2">
            <button type="button" className="shrink-0 overflow-hidden rounded-md border border-[var(--wc-line)]" title="查看选取时的截图"
              onClick={() => onPreview(item.id)}>
              <img src={item.previewUrl} alt="选取时的截图" className="h-10 w-14 object-cover" />
            </button>
            <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium" title={item.source.page.url}>{item.source.page.title || item.source.page.url || '网页'}</p>
              <p className="mt-0.5 text-xs text-[var(--wc-muted)]">{item.source.targets.length} 个目标 · 选取时的画面</p></div>
            {onEdit && <button type="button" className="wc-preview-action" title="重新编辑引用" aria-label="重新编辑引用" onClick={() => {
              clearTimeout(timer.current); pinned.current = false; setOpen(false); onEdit(item.id)
            }}><Pencil size={14} /></button>}
            {onRemove && <button type="button" className="wc-preview-action" title="移除引用" aria-label="移除引用" onClick={() => onRemove(item.id)}><Trash2 size={14} /></button>}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.source.comment}</p>
        </div>)}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
