export interface ScrollAreaMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

const FADE_EDGE_TOLERANCE_PX = 1
export const FOLLOW_SCROLL_END_THRESHOLD_PX = 24

export function scrollAreaFades(metrics: ScrollAreaMetrics): {
  top: boolean
  bottom: boolean
} {
  const maximum = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  const scrollTop = Math.min(Math.max(0, metrics.scrollTop), maximum)
  return {
    top: scrollTop > FADE_EDGE_TOLERANCE_PX,
    bottom: maximum - scrollTop > FADE_EDGE_TOLERANCE_PX,
  }
}

export function isNearScrollEnd(
  metrics: ScrollAreaMetrics,
  thresholdPx = FOLLOW_SCROLL_END_THRESHOLD_PX,
): boolean {
  const remaining = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop
  return remaining <= thresholdPx
}
