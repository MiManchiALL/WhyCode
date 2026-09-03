import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import {
  RIGHT_PANEL_MIN_WIDTH_RATIO,
  projectRightPanelDrag,
  rightPanelRatioFromWidth,
  rightPanelWidthBounds,
  rightPanelWidthExpression,
} from './right-panel-layout.ts'

interface RightPanelResizeHandleProps {
  panelRef: RefObject<HTMLDivElement | null>
  ratio: number
  maximumRatio: number
  onRatioChange: (ratio: number) => void
  onCollapse: () => void
  onPreviewExpand: (ratio: number) => void
  onResizeActiveChange: (active: boolean) => void
}

const KEYBOARD_STEP_RATIO = 0.02

export function RightPanelResizeHandle({
  panelRef,
  ratio,
  maximumRatio,
  onRatioChange,
  onCollapse,
  onPreviewExpand,
  onResizeActiveChange,
}: RightPanelResizeHandleProps) {
  const cancelDragRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cancelDragRef.current?.(), [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const handle = event.currentTarget
    const panel = panelRef.current
    const container = panel?.parentElement
    if (!panel || !container) return

    cancelDragRef.current?.()
    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = panel.getBoundingClientRect().width
    const viewportWidth = window.innerWidth
    const containerWidth = container.getBoundingClientRect().width
    let latestX = startX
    let latestWidth = startWidth
    let animationFrame: number | null = null
    let moved = false
    let finished = false
    let previewCollapsed = false

    panel.dataset.resizing = 'true'
    document.documentElement.dataset.wcRightPanelResizing = 'true'
    handle.setPointerCapture(pointerId)
    onResizeActiveChange(true)
    event.preventDefault()

    function applyLatestPosition(): void {
      animationFrame = null
      if (finished) return
      const projection = projectRightPanelDrag({
        startX,
        pointerX: latestX,
        startWidth,
        viewportWidth,
        containerWidth,
        maximumRatio,
        collapsed: previewCollapsed,
      })
      latestWidth = projection.width
      const collapsedChanged = previewCollapsed !== projection.shouldCollapse
      previewCollapsed = projection.shouldCollapse
      if (collapsedChanged) {
        if (previewCollapsed) onCollapse()
        else onPreviewExpand(rightPanelRatioFromWidth(latestWidth, viewportWidth))
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
      panel!.removeAttribute('data-resizing')
      delete document.documentElement.dataset.wcRightPanelResizing
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId)
      if (cancelDragRef.current === cancelWithoutCommit) cancelDragRef.current = null
    }

    function finish(flushPosition: boolean): void {
      if (finished) return
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      animationFrame = null
      if (flushPosition && moved) applyLatestPosition()
      finished = true
      removeDragEffects()
      if (previewCollapsed) {
        onRatioChange(RIGHT_PANEL_MIN_WIDTH_RATIO)
        onCollapse()
      } else if (moved) {
        const nextRatio = rightPanelRatioFromWidth(latestWidth, viewportWidth)
        panel!.style.width = rightPanelWidthExpression(nextRatio, maximumRatio)
        onRatioChange(nextRatio)
      }
      onResizeActiveChange(false)
    }

    function cancelWithoutCommit(): void {
      if (finished) return
      finished = true
      removeDragEffects()
      onResizeActiveChange(false)
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

    cancelDragRef.current = cancelWithoutCommit
    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerEnd)
    window.addEventListener('pointercancel', handlePointerCancel)
    window.addEventListener('blur', handleWindowBlur)
  }, [
    maximumRatio,
    onCollapse,
    onPreviewExpand,
    onRatioChange,
    onResizeActiveChange,
    panelRef,
  ])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    const container = panel?.parentElement
    if (!panel || !container) return
    const viewportWidth = window.innerWidth
    const bounds = rightPanelWidthBounds({
      viewportWidth,
      containerWidth: container.getBoundingClientRect().width,
      maximumRatio,
    })
    const currentWidth = panel.getBoundingClientRect().width
    const step = viewportWidth * KEYBOARD_STEP_RATIO
    let nextWidth: number
    switch (event.key) {
      case 'ArrowLeft':
        nextWidth = currentWidth + step
        break
      case 'ArrowRight':
        nextWidth = currentWidth - step
        break
      case 'Home':
        nextWidth = bounds.maxWidth
        break
      case 'End':
        nextWidth = bounds.minWidth
        break
      default:
        return
    }
    event.preventDefault()
    onRatioChange(rightPanelRatioFromWidth(
      Math.min(Math.max(nextWidth, bounds.minWidth), bounds.maxWidth),
      viewportWidth,
    ))
  }, [maximumRatio, onRatioChange, panelRef])

  return (
    <div
      className="wc-right-panel-resize-handle"
      role="separator"
      tabIndex={0}
      aria-label="调整右侧栏宽度"
      aria-orientation="vertical"
      aria-valuemin={RIGHT_PANEL_MIN_WIDTH_RATIO * 100}
      aria-valuemax={Math.round(maximumRatio * 100)}
      aria-valuenow={Math.round(ratio * 100)}
      title="拖动调整宽度；向右收起后，按住向左可恢复"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  )
}
