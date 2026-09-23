import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  loadPanelWidth, minimumConversationWidth, normalizePanelWidth, persistPanelWidth,
  type PanelGeometry, type PanelSide, type PanelWidths,
} from './panel-layout.ts'

export type PanelLayout = ReturnType<typeof usePanelLayout>

/** 两侧宽度归同一布局持有；拖拽预览只改 DOM，结束时一起提交用户偏好。 */
export function usePanelLayout() {
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
  const previewExpand = useCallback((side: PanelSide, width: number) => {
    setWidths(current => ({ ...current, [side]: normalizePanelWidth(side, width) }))
  }, [])
  const measure = useCallback((): PanelGeometry | null => {
    const left = leftRef.current
    const right = rightRef.current
    const container = right?.parentElement
    if (!left || !right || !container) return null
    const leftWidth = left.getBoundingClientRect().width
    return {
      viewportWidth: window.innerWidth,
      layoutWidth: leftWidth + container.getBoundingClientRect().width,
      widths: { left: leftWidth, right: right.getBoundingClientRect().width },
      open: { left: left.dataset.panelOpen === 'true', right: right.dataset.panelOpen === 'true' },
    }
  }, [])
  useLayoutEffect(() => {
    const update = () => {
      const geometry = measure()
      if (geometry) rightRef.current?.style.setProperty('--wc-conversation-min-width', `${minimumConversationWidth(geometry)}px`)
    }
    update()
    const observer = new ResizeObserver(update)
    if (rootRef.current) observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [measure])
  return { rootRef, refs, widths, commit, previewExpand, measure }
}
