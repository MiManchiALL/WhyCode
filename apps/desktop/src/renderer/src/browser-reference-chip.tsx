import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, MessageSquareText, Pencil, Trash2, X } from 'lucide-react'
import { BROWSER_REFERENCE_MAX_COMMENT, type BrowserReferenceSource } from '@whycode/core/browser-reference'

export interface BrowserReferenceItem { id: string; previewUrl: string; source: BrowserReferenceSource }

export function BrowserReferenceChip({ items, onRemove, onEdit, onPreview }: {
  items: readonly BrowserReferenceItem[]
  onRemove?: (id: string) => void
  onEdit?: (id: string, comment: string) => Promise<boolean>
  onPreview: (url: string, name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const pinned = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [editing, setEditing] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!items.length) return null
  const enter = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(true), 180) }
  const leave = () => { clearTimeout(timer.current); if (!pinned.current && !editing) timer.current = setTimeout(() => setOpen(false), 220) }
  const save = async (id: string) => {
    if (!onEdit || !comment.trim() || saving) return
    setSaving(true)
    try { if (await onEdit(id, comment)) setEditing(null) } finally { setSaving(false) }
  }
  return <Popover.Root open={open} onOpenChange={value => { clearTimeout(timer.current); pinned.current = value; setOpen(value); if (!value) setEditing(null) }}>
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
              onClick={() => onPreview(item.previewUrl, item.source.page.title || '网页引用')}>
              <img src={item.previewUrl} alt="选取时的截图" className="h-10 w-14 object-cover" />
            </button>
            <div className="min-w-0 flex-1"><p className="truncate text-xs font-medium" title={item.source.page.url}>{item.source.page.title || item.source.page.url || '网页'}</p>
              <p className="mt-0.5 text-xs text-[var(--wc-muted)]">{item.source.targets.length} 个目标 · 选取时的画面</p></div>
            {onEdit && <button type="button" className="wc-preview-action" title="编辑批注" aria-label="编辑批注" onClick={() => {
              setEditing(item.id); setComment(item.source.comment); pinned.current = true
            }}><Pencil size={14} /></button>}
            {onRemove && <button type="button" className="wc-preview-action" title="移除引用" aria-label="移除引用" onClick={() => onRemove(item.id)}><Trash2 size={14} /></button>}
          </div>
          {editing === item.id ? <div className="mt-2">
            <textarea autoFocus rows={3} className="wc-reference-textarea" value={comment} maxLength={BROWSER_REFERENCE_MAX_COMMENT} aria-label="编辑网页批注"
              onChange={event => setComment(event.target.value)} onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); void save(item.id) }
              }} />
            <div className="flex justify-end gap-2"><button className="wc-reference-secondary" onClick={() => setEditing(null)}>取消</button>
              <button className="wc-reference-submit" disabled={saving || !comment.trim()} onClick={() => { void save(item.id) }}><Check size={13} />保存</button></div>
          </div> : <p className="mt-2 whitespace-pre-wrap break-words text-sm">{item.source.comment}</p>}
        </div>)}
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
