import { useEffect, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ArrowUp, Check, GripHorizontal, Plus, X } from 'lucide-react'
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useSensor, useSensors, type Modifier } from '@dnd-kit/core'
import { BROWSER_REFERENCE_MAX_COMMENT, BROWSER_REFERENCE_MAX_TARGETS } from '@whycode/core/browser-reference'
import type { useBrowserReference } from './use-browser-reference.ts'

interface Props {
  reference: ReturnType<typeof useBrowserReference>
  boundary: HTMLElement | null
}

export function BrowserReferenceEditor(props: Props) {
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 3 } }), useSensor(KeyboardSensor))
  useEffect(() => { setOffset({ x: 0, y: 0 }) }, [props.reference.anchor])
  useEffect(() => {
    if (!props.boundary) return
    const resize = new ResizeObserver(() => setOffset({ x: 0, y: 0 }))
    resize.observe(props.boundary)
    return () => resize.disconnect()
  }, [props.boundary])
  const constrain: Modifier = ({ transform, draggingNodeRect }) => {
    if (!draggingNodeRect || !props.boundary) return transform
    const bounds = props.boundary.getBoundingClientRect()
    return { ...transform,
      x: Math.max(bounds.left + 8 - draggingNodeRect.left, Math.min(bounds.right - 8 - draggingNodeRect.right, transform.x)),
      y: Math.max(bounds.top + 8 - draggingNodeRect.top, Math.min(bounds.bottom - 8 - draggingNodeRect.bottom, transform.y)) }
  }
  return <DndContext sensors={sensors} modifiers={[constrain]} autoScroll={false}
    onDragEnd={({ delta }) => setOffset(current => ({ x: current.x + delta.x, y: current.y + delta.y }))}
    accessibility={{ screenReaderInstructions: { draggable: '按空格开始移动批注框，用方向键调整，回车放下，Esc 取消移动。' },
      announcements: { onDragStart: () => '已开始移动批注框', onDragOver: () => undefined,
        onDragEnd: () => '批注框已放下', onDragCancel: () => '已取消移动批注框' } }}>
    <ReferenceForm {...props} offset={offset} />
  </DndContext>
}

function ReferenceForm({ reference, boundary, offset }: Props & { offset: { x: number; y: number } }) {
  const input = useRef<HTMLTextAreaElement>(null)
  const drag = useDraggable({ id: 'browser-reference-editor' })
  const last = reference.captures.at(-1)?.target
  const open = reference.mode === 'comment' || reference.mode === 'saving'
  if (!last) return null
  const anchor = reference.anchor ?? { x: 0.5, y: 0.5, width: 0, height: 0 }
  const above = anchor.y, below = 1 - anchor.y - anchor.height
  const outside = Math.max(above, below) * (boundary?.clientHeight ?? 0) >= 200
  const side = outside && below >= above ? 'bottom' : 'top'
  const x = Math.max(4, Math.min(90, (anchor.x + anchor.width / 2) * 100))
  // 从选框外侧定位；目标占满视口时靠底部放置，避免弹层被压到无法操作。
  const y = outside ? (side === 'bottom' ? anchor.y + anchor.height : anchor.y) * 100 : 95
  return <Popover.Root open={open} onOpenChange={value => { if (!value && open) reference.escape() }}>
    <Popover.Anchor asChild><span className="pointer-events-none absolute h-px w-px" style={{ left: `${x}%`, top: `${y}%` }} /></Popover.Anchor>
    <Popover.Portal><Popover.Content ref={drag.setNodeRef} className="wc-reference-popover wc-reference-editor" sideOffset={10}
      style={{ transform: `translate(${offset.x + (drag.transform?.x ?? 0)}px, ${offset.y + (drag.transform?.y ?? 0)}px)` }}
      collisionBoundary={boundary} collisionPadding={10} side={side} align="center" aria-label="网页批注"
      onOpenAutoFocus={event => { event.preventDefault(); input.current?.focus() }}
      onCloseAutoFocus={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}
      onKeyDown={event => { if (event.key === 'Escape' && !drag.isDragging) event.stopPropagation() }}
      onEscapeKeyDown={event => { event.preventDefault(); if (!drag.isDragging && !event.isComposing) reference.escape() }}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" ref={drag.setActivatorNodeRef} {...drag.attributes} {...drag.listeners}
          className="wc-focus-ring flex min-w-0 flex-1 cursor-grab items-center gap-1.5 rounded py-1 text-xs font-medium active:cursor-grabbing"
          style={{ touchAction: 'none' }} aria-label="移动批注框" title="拖动移动批注框"
          onPointerDown={event => { if (event.button === 0) event.currentTarget.setPointerCapture(event.pointerId); drag.listeners?.onPointerDown?.(event) }}>
          <GripHorizontal size={13} className="text-[var(--wc-faint)]" />已选择 {reference.captures.length} 个目标
        </button>
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
          {last.kind === 'element' && <button className="wc-preview-action" aria-label="改选父元素" title="改选包住当前目标的父元素，保留原编号" disabled={reference.mode === 'saving'} onClick={() => reference.pick(reference.captures, true)}><ArrowUp size={14} /></button>}
        </div>
        <button className="wc-reference-submit" disabled={!reference.comment.trim() || reference.mode === 'saving'} onClick={() => { void reference.save() }}>
          <Check size={13} />{reference.mode === 'saving' ? '正在保存…' : reference.editing ? '更新引用' : '加入对话'}
        </button>
      </div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
