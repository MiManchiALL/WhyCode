import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  loadPanelWidth, minimumConversationWidth, normalizePanelWidth, persistPanelWidth, panelWidthBounds,
  SESSION_SIDEBAR_COLLAPSED_WIDTH,
  type PanelGeometry, type PanelSide, type PanelWidths,
} from './panel-layout.ts'

export type PanelLayout = ReturnType<typeof usePanelLayout>

/** 连续调宽只改 DOM；开合沿用 App 状态，结束时一起提交两侧宽度偏好。 */
export function usePanelLayout(rightOpen: boolean, onOpenChange: (side: PanelSide, open: boolean) => void) {
  const rootRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const refs = useMemo(() => ({ left: leftRef, right: rightRef }), [])
  const [widths, setWidths] = useState<PanelWidths>(() => ({ left: loadPanelWidth('left'), right: loadPanelWidth('right') }))
  const commit = useCallback((values: Partial<PanelWidths>) => {
    const changes: Partial<PanelWidths> = {}
    for (const side of ['left', 'right'] as const) {
      if (values[side] === undefined) continue
      const width = normalizePanelWidth(side, values[side])
      changes[side] = width
      persistPanelWidth(side, width)
    }
    setWidths(current => ({ ...current, ...changes }))
  }, [])
  const previewOpen = useCallback((side: PanelSide, open: boolean, width: number) => {
    if (open) setWidths(current => ({ ...current, [side]: normalizePanelWidth(side, width) }))
    onOpenChange(side, open)
  }, [onOpenChange])
  const measure = useCallback((): PanelGeometry | null => {
    const left = leftRef.current
    const right = rightRef.current
    const container = right?.parentElement
    if (!left || !right || !container) return null
    const leftWidth = left.getBoundingClientRect().width
    const rightStyle = getComputedStyle(right)
    const open = { left: left.dataset.panelOpen === 'true', right: right.dataset.panelOpen === 'true' }
    const collapsedWidths = {
      left: SESSION_SIDEBAR_COLLAPSED_WIDTH,
      right: parseFloat(rightStyle.getPropertyValue('--wc-panel-collapsed-width'))
        + parseFloat(rightStyle.getPropertyValue('--wc-panel-collapsed-gap')),
    }
    return {
      viewportWidth: window.innerWidth,
      layoutWidth: leftWidth + container.getBoundingClientRect().width,
      widths: {
        left: open.left ? leftWidth : collapsedWidths.left,
        right: open.right ? right.getBoundingClientRect().width + parseFloat(rightStyle.marginLeft) : collapsedWidths.right,
      },
      collapsedWidths,
      open,
    }
  }, [])
  useLayoutEffect(() => {
    const update = () => {
      const geometry = measure()
      if (!geometry) return
      rightRef.current?.style.setProperty('--wc-conversation-min-width', `${minimumConversationWidth(geometry)}px`)
      leftRef.current?.style.setProperty('--wc-panel-max-width', `${panelWidthBounds({ ...geometry, side: 'left' }).maxWidth}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    if (rootRef.current) observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [measure, rightOpen])
  return { rootRef, refs, widths, commit, previewOpen, measure }
}
