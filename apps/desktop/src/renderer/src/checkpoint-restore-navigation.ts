import { useLayoutEffect, useRef } from 'react'
import type { ToolBatchPresentationItem } from './conversation-tool-batches.ts'
import type { ConversationScrollAlignment } from './conversation-scroll.ts'

export function useCheckpointRestoreNavigation({
  runtimeId, sectionId, items, anchors, expandedIds, onToggle, onNavigate,
}: {
  runtimeId: string
  sectionId: string
  items: readonly ToolBatchPresentationItem[]
  anchors: ReadonlySet<string>
  expandedIds: ReadonlySet<string>
  onToggle: (id: string) => void
  onNavigate?: (target: HTMLElement, alignment: ConversationScrollAlignment) => void
}) {
  const ref = useRef<HTMLElement>(null)
  const release = useRef<(() => void) | null>(null)
  const segment = items.find(item => item.kind === 'tool-segment'
    && item.batch.tools.some(block => anchors.has(block.call.id)))
  const batch = segment?.kind === 'tool-segment' ? segment.batch : null
  const toolUseId = batch?.tools.find(block => anchors.has(block.call.id))?.call.id
  useLayoutEffect(() => () => { release.current?.(); release.current = null }, [runtimeId, toolUseId])

  const navigate = toolUseId && batch && onNavigate ? () => {
    release.current?.()
    for (const id of [sectionId, batch.id]) if (!expandedIds.has(id)) onToggle(id)
    // 展开和工具组封口先完成布局，再复用会话定位，避免使用折叠前的几何位置。
    const frame = window.requestAnimationFrame(() => {
      release.current = null
      const target = Array.from(ref.current?.querySelectorAll<HTMLElement>('[data-checkpoint-restore]') ?? [])
        .find(element => element.dataset.checkpointRestore === toolUseId && !element.closest('[inert]'))
      if (!target) return
      onNavigate(target, 'center')
      target.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
      release.current = highlightRestoreTarget(target)
    })
    release.current = () => window.cancelAnimationFrame(frame)
  } : undefined
  return { ref, navigate }
}

function highlightRestoreTarget(target: HTMLElement): () => void {
  const row = target.closest('.wc-tool-row')
  target.dataset.navigationHighlight = 'true'
  const timer = window.setTimeout(clear, 3_000)
  target.addEventListener('pointerleave', clear)
  row?.addEventListener('pointerleave', clear)
  row?.addEventListener('click', clear)
  function clear() {
    window.clearTimeout(timer)
    delete target.dataset.navigationHighlight
    target.removeEventListener('pointerleave', clear)
    row?.removeEventListener('pointerleave', clear)
    row?.removeEventListener('click', clear)
  }
  return clear
}
