import { useRef } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUp, Check, Plus, X } from 'lucide-react'
import { BROWSER_REFERENCE_MAX_COMMENT, BROWSER_REFERENCE_MAX_TARGETS } from '@whycode/core/browser-reference'
import type { useBrowserReference } from './use-browser-reference.ts'

export function BrowserReferenceEditor({ reference, boundary }: {
  reference: ReturnType<typeof useBrowserReference>
  boundary: HTMLElement | null
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const last = reference.captures.at(-1)?.target
  const open = reference.mode === 'comment' || reference.mode === 'saving'
  if (!last) return null
  const x = Math.max(4, Math.min(90, (last.rect.x - last.viewport.scrollX + last.rect.width / 2) / last.viewport.width * 100))
  const y = Math.max(4, Math.min(75, (last.rect.y - last.viewport.scrollY + Math.min(last.rect.height, 80)) / last.viewport.height * 100))
  return <Popover.Root open={open} onOpenChange={value => { if (!value && open) reference.escape() }}>
    <Popover.Anchor asChild><span className="pointer-events-none absolute h-px w-px" style={{ left: `${x}%`, top: `${y}%` }} /></Popover.Anchor>
    <Popover.Portal><Popover.Content className="wc-reference-popover wc-reference-editor" sideOffset={10}
      collisionBoundary={boundary} collisionPadding={10} side="bottom" align="center" aria-label="网页批注"
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}
      onCloseAutoFocus={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}
      onKeyDown={event => { if (event.key === 'Escape') event.stopPropagation() }}
      onEscapeKeyDown={event => { event.preventDefault(); reference.escape() }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">已选择 {reference.captures.length} 个目标</span>
        <button className="wc-preview-action" title="取消本条引用" aria-label="取消本条引用" onClick={reference.escape}><X size={14} /></button>
      </div>
      <div className="wc-scrollbar mt-1 flex max-h-24 flex-wrap gap-1 overflow-auto">
        {reference.captures.map((capture, index) => <span key={capture.target.id} className="wc-reference-target">
          <b>{index + 1}</b><span className="truncate">{capture.target.label}</span>
          <button aria-label={`移除目标 ${index + 1}`} title="移除目标" onClick={() => reference.remove(index)}><X size={12} /></button>
        </span>)}
      </div>
      <textarea ref={input} value={reference.comment} maxLength={BROWSER_REFERENCE_MAX_COMMENT} aria-label="批注内容"
        placeholder="希望如何修改这些内容？" className="wc-reference-textarea" rows={3}
        onChange={event => reference.setComment(event.target.value)} disabled={reference.mode === 'saving'}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
          event.preventDefault(); event.stopPropagation(); void reference.save()
        } }} />
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <div className="flex items-center gap-0.5">
          <button className="wc-reference-secondary" disabled={reference.captures.length >= BROWSER_REFERENCE_MAX_TARGETS || reference.mode === 'saving'} onClick={() => reference.pick()}><Plus size={13} />继续选择</button>
          {last.kind === 'element' && <button className="wc-preview-action" aria-label="改选父元素" title="改选父元素" disabled={reference.mode === 'saving'} onClick={() => reference.pick(reference.captures, true)}><ArrowUp size={14} /></button>}
        </div>
        <button className="wc-reference-submit" disabled={!reference.comment.trim() || reference.mode === 'saving'} onClick={() => { void reference.save() }}>
          <Check size={13} />{reference.mode === 'saving' ? '正在添加…' : '加入对话'}
        </button>
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
