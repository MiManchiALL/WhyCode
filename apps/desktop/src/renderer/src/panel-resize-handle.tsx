import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  PANEL_WIDTHS,
  projectPanelDrag,
  panelWidthFromPixels,
  panelWidthBounds,
  panelWidthExpression,
  type PanelSide,
} from './panel-layout.ts'

interface PanelResizeHandleProps {
  side: PanelSide
  panelRef: RefObject<HTMLElement | null>
  width: number
  onWidthChange: (width: number) => void
  onCollapse: () => void
  onPreviewExpand: (width: number) => void
  onResizeActiveChange: (active: boolean) => void
}

export function PanelResizeHandle({
  side,
  panelRef,
  width,
  onWidthChange,
  onCollapse,
  onPreviewExpand,
  onResizeActiveChange,
}: PanelResizeHandleProps) {
  const finishDragRef = useRef<(() => void) | null>(null)

  useEffect(() => () => finishDragRef.current?.(), [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const handle = event.currentTarget
    const panel = panelRef.current
    const container = panel?.parentElement
    if (!panel || !container) return

    finishDragRef.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = panel.getBoundingClientRect().width
    const viewportWidth = window.innerWidth
    const bounds = panelWidthBounds({ side, viewportWidth, containerWidth: container.getBoundingClientRect().width })
    let latestX = startX
    let latestWidth = startWidth
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
      latestWidth = projection.width
      const collapsedChanged = previewCollapsed !== projection.shouldCollapse
      previewCollapsed = projection.shouldCollapse
      if (collapsedChanged) {
        if (previewCollapsed) onCollapse()
        else onPreviewExpand(panelWidthFromPixels(side, latestWidth, viewportWidth))
      }
      if (!previewCollapsed) panel!.style.width = `${projection.width.toFixed(2)}px`
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
      if (previewCollapsed) {
        onWidthChange(PANEL_WIDTHS[side].minimum)
      } else if (moved) {
        const nextWidth = panelWidthFromPixels(side, latestWidth, viewportWidth)
        panel!.style.width = panelWidthExpression(side, nextWidth)
        onWidthChange(nextWidth)
      }
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
    onWidthChange,
    onResizeActiveChange,
    panelRef,
  ])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    const container = panel?.parentElement
    if (!panel || !container) return
    const viewportWidth = window.innerWidth
    const bounds = panelWidthBounds({
      side,
      viewportWidth,
      containerWidth: container.getBoundingClientRect().width,
    })
    const currentWidth = panel.getBoundingClientRect().width
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
    onWidthChange(panelWidthFromPixels(
      side,
      Math.min(Math.max(nextWidth, bounds.minWidth), bounds.maxWidth),
      viewportWidth,
    ))
  }, [side, onWidthChange, panelRef])

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
