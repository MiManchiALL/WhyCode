import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  PANEL_WIDTHS,
  projectPanelDrag,
  panelWidthFromPixels,
  panelWidthBounds,
  panelWidthExpression,
  projectPanelWidths,
  type PanelSide,
  type PanelWidths,
} from './panel-layout.ts'
import type { PanelLayout } from './use-panel-layout.ts'

interface PanelResizeHandleProps {
  side: PanelSide
  layout: PanelLayout
  onCollapse: () => void
  onPreviewExpand: (width: number) => void
  onResizeActiveChange: (active: boolean) => void
}

export function PanelResizeHandle({
  side,
  layout,
  onCollapse,
  onPreviewExpand,
  onResizeActiveChange,
}: PanelResizeHandleProps) {
  const finishDragRef = useRef<(() => void) | null>(null)
  const panelRef = layout.refs[side]
  const width = layout.widths[side]

  useEffect(() => () => finishDragRef.current?.(), [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const handle = event.currentTarget
    const panel = panelRef.current
    const geometry = layout.measure()
    if (!panel || !geometry) return
    const peerSide = side === 'left' ? 'right' : 'left'
    const peer = layout.refs[peerSide].current

    finishDragRef.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = geometry.widths[side]
    const viewportWidth = geometry.viewportWidth
    const bounds = panelWidthBounds({ ...geometry, side })
    let latestX = startX
    let latestWidths = geometry.widths
    let animationFrame: number | null = null
    let moved = false
    let finished = false
    let previewCollapsed = false

    panel.dataset.resizing = 'true'
    document.documentElement.dataset.wcPanelResizing = 'true'
    handle.setPointerCapture(pointerId)
    onResizeActiveChange(true)
    event.preventDefault()

    function applyLatestPosition(): void {
      animationFrame = null
      if (finished || !moved) return
      const projection = projectPanelDrag({
        side,
        startX,
        pointerX: latestX,
        startWidth,
        bounds,
        collapsed: previewCollapsed,
      })
      latestWidths = projectPanelWidths(geometry!, side, projection.width)
      const collapsedChanged = previewCollapsed !== projection.shouldCollapse
      previewCollapsed = projection.shouldCollapse
      if (collapsedChanged) {
        if (previewCollapsed) onCollapse()
        else onPreviewExpand(panelWidthFromPixels(side, latestWidths[side], viewportWidth))
      }
      if (peer && geometry!.open[peerSide]) peer.style.width = `${latestWidths[peerSide].toFixed(2)}px`
      if (!previewCollapsed) panel!.style.width = `${latestWidths[side].toFixed(2)}px`
    }

    function removeDragEffects(): void {
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      animationFrame = null
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerEnd)
      window.removeEventListener('pointercancel', handlePointerCancel)
      window.removeEventListener('blur', handleWindowBlur)
      window.removeEventListener('resize', handleWindowBlur)
      panel!.removeAttribute('data-resizing')
      delete document.documentElement.dataset.wcPanelResizing
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      if (finishDragRef.current === finishWithoutFlush) finishDragRef.current = null
    }

    function finish(flushPosition: boolean): void {
      if (finished) return
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      animationFrame = null
      if (flushPosition && moved) applyLatestPosition()
      finished = true
      removeDragEffects()
      const changes: Partial<PanelWidths> = {}
      if (previewCollapsed) {
        changes[side] = PANEL_WIDTHS[side].minimum
      } else if (moved) {
        const nextWidth = panelWidthFromPixels(side, latestWidths[side], viewportWidth)
        panel!.style.width = panelWidthExpression(side, nextWidth)
        changes[side] = nextWidth
      }
      if (moved && peer && geometry!.open[peerSide]) {
        const changed = Math.abs(latestWidths[peerSide] - geometry!.widths[peerSide]) >= 0.5
        const peerWidth = changed ? panelWidthFromPixels(peerSide, latestWidths[peerSide], viewportWidth) : layout.widths[peerSide]
        peer.style.width = panelWidthExpression(peerSide, peerWidth)
        if (changed) changes[peerSide] = peerWidth
      }
      if (Object.keys(changes).length) layout.commit(changes)
      onResizeActiveChange(false)
    }

    function finishWithoutFlush(): void {
      finish(false)
    }

    function handlePointerMove(pointerEvent: PointerEvent): void {
      if (pointerEvent.pointerId !== pointerId) return
      latestX = pointerEvent.clientX
      moved ||= Math.abs(latestX - startX) >= 0.5
      if (animationFrame === null) {
        animationFrame = window.requestAnimationFrame(applyLatestPosition)
      }
      pointerEvent.preventDefault()
    }

    function handlePointerEnd(pointerEvent: PointerEvent): void {
      if (pointerEvent.pointerId !== pointerId) return
      latestX = pointerEvent.clientX
      moved ||= Math.abs(latestX - startX) >= 0.5
      finish(true)
    }

    function handlePointerCancel(pointerEvent: PointerEvent): void {
      if (pointerEvent.pointerId !== pointerId) return
      finish(true)
    }

    function handleWindowBlur(): void {
      finish(true)
    }

    finishDragRef.current = finishWithoutFlush
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('blur', handleWindowBlur)
    window.addEventListener('resize', handleWindowBlur)
  }, [
    side,
    onCollapse,
    onPreviewExpand,
    layout,
    onResizeActiveChange,
    panelRef,
  ])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    const geometry = layout.measure()
    if (!panel || !geometry) return
    const viewportWidth = geometry.viewportWidth
    const bounds = panelWidthBounds({ ...geometry, side })
    const currentWidth = geometry.widths[side]
    const step = side === 'left' ? 16 : viewportWidth * 0.02
    let nextWidth: number
    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = currentWidth + (side === 'left' ? -step : step)
        break
      case 'ArrowRight':
        nextWidth = currentWidth + (side === 'left' ? step : -step)
        break
      case 'Home':
        nextWidth = side === 'left' ? bounds.minWidth : bounds.maxWidth
        break
      case 'End':
        nextWidth = side === 'left' ? bounds.maxWidth : bounds.minWidth
        break
      default:
        return
    }
    event.preventDefault()
    const projected = projectPanelWidths(geometry, side, nextWidth)
    const changes: Partial<PanelWidths> = { [side]: panelWidthFromPixels(side, projected[side], viewportWidth) }
    const peer = side === 'left' ? 'right' : 'left'
    if (geometry.open[peer] && Math.abs(projected[peer] - geometry.widths[peer]) >= 0.5) {
      changes[peer] = panelWidthFromPixels(peer, projected[peer], viewportWidth)
    }
    layout.commit(changes)
  }, [side, layout, panelRef])

  return (
    <div
      className="wc-panel-resize-handle"
      data-side={side}
      role="separator"
      tabIndex={0}
      aria-label={side === 'left' ? '调整会话侧栏宽度' : '调整右侧栏宽度'}
      aria-orientation="vertical"
      aria-valuemin={PANEL_WIDTHS[side].minimum}
      aria-valuemax={PANEL_WIDTHS[side].maximum}
      aria-valuenow={width}
      aria-valuetext={side === 'left' ? `${Math.round(width)} 像素` : `${Math.round(width * 100)}%`}
      title={side === 'left'
        ? '拖动调整宽度；向左收起后，按住向右可恢复'
        : '拖动调整宽度；向右收起后，按住向左可恢复'}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}
