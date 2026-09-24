import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  PANEL_WIDTHS,
  PANEL_CLOSE_OVERSHOOT,
  panelWidthFromPixels,
  panelWidthBounds,
  panelWidthExpression,
  projectPanelResize,
  type PanelSide,
  type PanelWidths,
} from './panel-layout.ts'
import type { PanelLayout } from './use-panel-layout.ts'

interface PanelResizeHandleProps {
  side: PanelSide
  layout: PanelLayout
  onResizeActiveChange: (active: boolean) => void
}

export function PanelResizeHandle({
  side,
  layout,
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
    finishDragRef.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = geometry.widths[side]
    const viewportWidth = geometry.viewportWidth
    let latestX = startX
    let latest = { widths: geometry.widths, open: geometry.open }
    let animationFrame: number | null = null
    let moved = false
    let finished = false

    panel.dataset.resizing = 'true'
    document.documentElement.dataset.wcPanelResizing = 'true'
    handle.setPointerCapture(pointerId)
    onResizeActiveChange(true)
    event.preventDefault()

    function applyLatestPosition(): void {
      animationFrame = null
      if (finished || !moved) return
      const projection = projectPanelResize({
        geometry: geometry!,
        side,
        requestedWidth: startWidth + (latestX - startX) * (side === 'left' ? 1 : -1),
        previousOpen: latest.open,
        closeOvershoot: PANEL_CLOSE_OVERSHOOT,
      })
      for (const target of ['left', 'right'] as const) {
        if (projection.open[target] !== latest.open[target]) {
          layout.previewOpen(target, projection.open[target], panelWidthFromPixels(target, projection.widths[target], viewportWidth))
        }
        const element = layout.refs[target].current
        if (element && projection.open[target]) element.style.width = `${projection.widths[target].toFixed(2)}px`
      }
      latest = projection
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
      for (const target of ['left', 'right'] as const) {
        if (!moved || !geometry!.open[target]) continue
        if (!latest.open[target]) {
          changes[target] = PANEL_WIDTHS[target].minimum
          continue
        }
        const changed = target === side || Math.abs(latest.widths[target] - geometry!.widths[target]) >= 0.5
        const nextWidth = changed ? panelWidthFromPixels(target, latest.widths[target], viewportWidth) : layout.widths[target]
        const element = layout.refs[target].current
        if (element) element.style.width = panelWidthExpression(target, nextWidth)
        if (changed) changes[target] = nextWidth
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
    const maximum = side === 'left' ? PANEL_WIDTHS.left.maximum : viewportWidth * PANEL_WIDTHS.right.maximum
    let nextWidth: number
    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = currentWidth + (side === 'left' ? -step : step)
        break
      case 'ArrowRight':
        nextWidth = currentWidth + (side === 'left' ? step : -step)
        break
      case 'Home':
        nextWidth = side === 'left' ? bounds.minWidth : maximum
        break
      case 'End':
        nextWidth = side === 'left' ? maximum : bounds.minWidth
        break
      default:
        return
    }
    event.preventDefault()
    const projected = projectPanelResize({
      geometry, side, requestedWidth: Math.max(nextWidth, bounds.minWidth),
      previousOpen: geometry.open, closeOvershoot: 0,
    })
    const changes: Partial<PanelWidths> = {}
    for (const target of ['left', 'right'] as const) {
      if (projected.open[target] !== geometry.open[target]) {
        layout.previewOpen(target, projected.open[target], PANEL_WIDTHS[target].minimum)
      }
      if (!geometry.open[target]) continue
      if (!projected.open[target]) changes[target] = PANEL_WIDTHS[target].minimum
      else if (target === side || Math.abs(projected.widths[target] - geometry.widths[target]) >= 0.5) {
        changes[target] = panelWidthFromPixels(target, projected.widths[target], viewportWidth)
      }
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
