import { useRef } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { ImageViewport } from './image-viewport.tsx'

export interface ImagePreviewTarget {
  id: string
  src: string
  name: string
  details?: string
}

export function ImagePreviewDialog({
  targets,
  selectedId,
  onSelect,
}: {
  targets: readonly ImagePreviewTarget[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) {
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const index = targets.findIndex(target => target.id === selectedId)
  const target = targets[index]
  if (!target) return null
  const previous = targets[index - 1]
  const next = targets[index + 1]
  const move = (direction: -1 | 1) => {
    const item = targets[index + direction]
    if (item) onSelect(item.id)
  }
  return (
    <Dialog.Root open onOpenChange={open => { if (!open) onSelect(null) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="wc-dialog-overlay fixed inset-0 z-[90] bg-black/75" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[91] flex max-h-[92vh] w-[min(92vw,72rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-neutral-950 text-white shadow-2xl outline-none"
          aria-describedby={undefined}
          onOpenAutoFocus={() => { returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus()
          }}
          onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            move(event.key === 'ArrowLeft' ? -1 : 1)
          }}
        >
          <div className="flex shrink-0 items-center gap-4 border-b border-white/15 px-4 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="truncate text-sm font-medium" title={target.name}>{target.name}</Dialog.Title>
              {target.details && <div className="truncate text-xs text-neutral-400" title={target.details}>{target.details}</div>}
            </div>
            {targets.length > 1 && <span className="shrink-0 text-xs tabular-nums text-neutral-300" aria-live="polite" aria-atomic="true">{index + 1} / {targets.length}</span>}
            <Dialog.Close
              type="button"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-neutral-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              aria-label="关闭图片预览"
              title="关闭（Esc）"
            >
              <X size={20} />
            </Dialog.Close>
          </div>
          <div className={`relative flex min-h-0 flex-col pt-4 ${targets.length > 1 ? 'px-14' : 'px-4'}`}>
            {targets.length > 1 && <button type="button" className={`${navigationButtonClass} left-3`} disabled={!previous}
              onClick={() => move(-1)} aria-label="上一张图片" title="上一张（←）"><ChevronLeft size={20} /></button>}
            <ImageViewport key={`${target.id}:${target.src}`} src={target.src} name={target.name} />
            {targets.length > 1 && <button type="button" className={`${navigationButtonClass} right-3`} disabled={!next}
              onClick={() => move(1)} aria-label="下一张图片" title="下一张（→）"><ChevronRight size={20} /></button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

const navigationButtonClass = 'absolute top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white text-neutral-900 shadow-sm transition-colors hover:bg-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:pointer-events-none disabled:opacity-30'
