export type PanelSide = 'left' | 'right'
export type PanelWidths = Record<PanelSide, number>

export interface PanelGeometry {
  viewportWidth: number
  layoutWidth: number
  widths: PanelWidths
  collapsedWidths: PanelWidths
  open: Record<PanelSide, boolean>
}

export const SESSION_SIDEBAR_COLLAPSED_WIDTH = 62
export const MIN_CONVERSATION_WIDTH = 420
export const PANEL_CLOSE_OVERSHOOT = 72

// 会话列表保存像素宽度，文件侧栏保存窗口比例；响应式限宽不改写偏好。
export const PANEL_WIDTHS = {
  left: { minimum: 240, maximum: 360, default: 260, viewportLimit: 0.3, storageKey: 'whycode:session-sidebar-width:v1' },
  right: { minimum: 0.2, maximum: 0.5, default: 0.36, storageKey: 'whycode:right-panel-width-ratio:v1' },
} as const

export interface PanelWidthBounds {
  minWidth: number
  maxWidth: number
}

export function normalizePanelWidth(side: PanelSide, value: number): number {
  const { minimum, maximum, default: fallback } = PANEL_WIDTHS[side]
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback
}

export function parsePanelWidth(side: PanelSide, value: string | null): number {
  return value === null || value.trim() === ''
    ? PANEL_WIDTHS[side].default
    : normalizePanelWidth(side, Number(value))
}

export function loadPanelWidth(side: PanelSide): number {
  try {
    return parsePanelWidth(side, globalThis.localStorage.getItem(PANEL_WIDTHS[side].storageKey))
  } catch {
    return PANEL_WIDTHS[side].default
  }
}

export function persistPanelWidth(side: PanelSide, value: number): void {
  try {
    globalThis.localStorage.setItem(PANEL_WIDTHS[side].storageKey, String(normalizePanelWidth(side, value)))
  } catch {
    // 存储不可用时，当前窗口内的宽度选择仍然有效。
  }
}

export function panelWidthExpression(side: PanelSide, value: number): string {
  const width = normalizePanelWidth(side, value)
  if (side === 'left') return `min(${width}px, ${PANEL_WIDTHS.left.viewportLimit * 100}vw)`
  const percent = Number((width * 100).toFixed(4))
  return `min(${percent}vw, max(0px, calc(100% - var(--wc-conversation-min-width))))`
}

function intrinsicPanelBounds(side: PanelSide, viewportWidth: number): PanelWidthBounds {
  if (side === 'left') {
    const maxWidth = Math.min(PANEL_WIDTHS.left.maximum, viewportWidth * PANEL_WIDTHS.left.viewportLimit)
    return { minWidth: Math.min(PANEL_WIDTHS.left.minimum, maxWidth), maxWidth }
  }
  return { minWidth: viewportWidth * PANEL_WIDTHS.right.minimum, maxWidth: viewportWidth * PANEL_WIDTHS.right.maximum }
}

export function minimumConversationWidth(input: Pick<PanelGeometry, 'viewportWidth' | 'layoutWidth'>): number {
  const viewportWidth = finiteNonNegative(input.viewportWidth)
  const available = finiteNonNegative(input.layoutWidth)
  const left = intrinsicPanelBounds('left', viewportWidth)
  // 保留左侧 360px、右侧 45% 的阅读基线；新增侧栏空间由两侧互相让出。
  return Math.min(Math.max(0, available - left.minWidth),
    Math.max(MIN_CONVERSATION_WIDTH, available - left.maxWidth - viewportWidth * 0.45))
}

export function panelWidthBounds(input: PanelGeometry & { side: PanelSide }): PanelWidthBounds {
  const own = intrinsicPanelBounds(input.side, finiteNonNegative(input.viewportWidth))
  const peer = input.side === 'left' ? 'right' : 'left'
  const peerMinimum = input.open[peer]
    ? Math.min(input.widths[peer], intrinsicPanelBounds(peer, input.viewportWidth).minWidth)
    : input.widths[peer]
  const available = Math.max(0, input.layoutWidth - minimumConversationWidth(input) - peerMinimum)
  const maxWidth = Math.min(own.maxWidth, available)
  return { minWidth: Math.min(own.minWidth, maxWidth), maxWidth }
}

export function projectPanelResize(input: {
  geometry: PanelGeometry
  side: PanelSide
  requestedWidth: number
  previousOpen: PanelGeometry['open']
  closeOvershoot: number
}): Pick<PanelGeometry, 'widths' | 'open'> {
  const { geometry, side, requestedWidth, previousOpen, closeOvershoot } = input
  const peer = side === 'left' ? 'right' : 'left'
  const expandedBounds = panelWidthBounds({ ...geometry, side })
  const collapsedBounds = panelWidthBounds({
    ...geometry, side,
    widths: { ...geometry.widths, [peer]: geometry.collapsedWidths[peer] },
    open: { ...geometry.open, [peer]: false },
  })
  // 只有收起确实能继续调宽时才跨过边界；回到展开边界后恢复，避免临界点抖动。
  const collapsePeer = geometry.open[peer]
    && collapsedBounds.maxWidth > expandedBounds.maxWidth
    && requestedWidth > expandedBounds.maxWidth
    && (!previousOpen[peer] || requestedWidth - expandedBounds.maxWidth >= closeOvershoot)
  const bounds = collapsePeer ? collapsedBounds : expandedBounds
  const collapseOwn = bounds.maxWidth > 0 && requestedWidth < bounds.minWidth
    && (!previousOpen[side] || bounds.minWidth - requestedWidth >= closeOvershoot)
  const widths = {
    ...geometry.widths,
    [side]: collapseOwn ? geometry.collapsedWidths[side] : clamp(requestedWidth, bounds.minWidth, bounds.maxWidth),
  }
  if (geometry.open[peer]) {
    widths[peer] = collapsePeer ? geometry.collapsedWidths[peer]
      : Math.min(geometry.widths[peer], Math.max(0, geometry.layoutWidth - minimumConversationWidth(geometry) - widths[side]))
  }
  return { widths, open: { ...geometry.open, [side]: !collapseOwn, [peer]: geometry.open[peer] && !collapsePeer } }
}

export function panelWidthFromPixels(side: PanelSide, width: number, viewportWidth: number): number {
  if (side === 'left') return normalizePanelWidth(side, width)
  return normalizePanelWidth(side, viewportWidth > 0 ? width / viewportWidth : Number.NaN)
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
