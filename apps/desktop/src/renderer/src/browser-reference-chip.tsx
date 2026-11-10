import * as Popover from '@radix-ui/react-popover'
import { MessageSquareText, Pencil, Trash2 } from 'lucide-react'
import type { BrowserReferenceSource } from '@whycode/core/browser-reference'
import { ReferenceChip } from './reference-chip.tsx'

export interface BrowserReferenceItem { id: string; previewUrl: string; source: BrowserReferenceSource }

export function BrowserReferenceChip({ items, onRemove, onEdit, onPreview }: {
  items: readonly BrowserReferenceItem[]
  onRemove?: (id: string) => void
  onEdit?: (id: string) => void
  onPreview: (id: string) => void
}) {
  if (!items.length) return null
  return <ReferenceChip name="网页引用" count={items.length} icon={MessageSquareText}>
    {items.map(item => <div key={item.id} className="min-w-0 border-t border-[var(--wc-line)] pt-2 first:border-0 first:pt-0">
      <div className="flex min-w-0 items-center gap-2">
        <button type="button" className="shrink-0 overflow-hidden rounded-md border border-[var(--wc-line)]" title="查看选取时的截图"
          onClick={() => onPreview(item.id)}>
          <img src={item.previewUrl} alt="选取时的截图" className="h-10 w-14 object-cover" />
        </button>
        <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium" title={item.source.page.url}>{item.source.page.title || item.source.page.url || '网页'}</p>
          <p className="mt-0.5 text-xs text-[var(--wc-muted)]">{item.source.targets.length} 个目标 · 选取时的画面</p></div>
        {onEdit && <Popover.Close asChild><button type="button" className="wc-preview-action" title="重新编辑引用"
          aria-label="重新编辑引用" onClick={() => onEdit(item.id)}><Pencil size={14} /></button></Popover.Close>}
        {onRemove && <button type="button" className="wc-preview-action" title="移除引用" aria-label="移除引用" onClick={() => onRemove(item.id)}><Trash2 size={14} /></button>}
      </div>
      <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.source.comment}</p>
    </div>)}
  </ReferenceChip>
}
