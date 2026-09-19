export type PanelSide = 'left' | 'right'

export const SESSION_SIDEBAR_COLLAPSED_WIDTH = 62
export const MIN_CONVERSATION_WIDTH = 420
export const PANEL_CLOSE_OVERSHOOT = 72

// 会话列表保存像素宽度，文件侧栏保存窗口比例；响应式限宽不改写偏好。
export const PANEL_WIDTHS = {
  left: { minimum: 240, maximum: 360, default: 260, viewportLimit: 0.3, storageKey: 'whycode:session-sidebar-width:v1' },
  right: { minimum: 0.2, maximum: 0.4, default: 0.36, storageKey: 'whycode:right-panel-width-ratio:v1' },
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
  return `min(${percent}vw, max(0px, calc(100% - ${MIN_CONVERSATION_WIDTH}px)))`
}

export function panelWidthBounds(input: {
  side: PanelSide
  viewportWidth: number
  containerWidth: number
}): PanelWidthBounds {
  const viewportWidth = finiteNonNegative(input.viewportWidth)
  if (input.side === 'left') {
    const maxWidth = Math.min(PANEL_WIDTHS.left.maximum, viewportWidth * PANEL_WIDTHS.left.viewportLimit)
    return { minWidth: Math.min(PANEL_WIDTHS.left.minimum, maxWidth), maxWidth }
  }
  const availableWidth = Math.max(0, finiteNonNegative(input.containerWidth) - MIN_CONVERSATION_WIDTH)
  const maxWidth = Math.min(availableWidth, viewportWidth * PANEL_WIDTHS.right.maximum)
  return { minWidth: Math.min(viewportWidth * PANEL_WIDTHS.right.minimum, maxWidth), maxWidth }
}

export function projectPanelDrag(input: {
  side: PanelSide
  startX: number
  pointerX: number
  startWidth: number
  bounds: PanelWidthBounds
  collapsed: boolean
}): { width: number; shouldCollapse: boolean } {
  const { minWidth, maxWidth } = input.bounds
  const direction = input.side === 'left' ? 1 : -1
  const rawWidth = input.startWidth + (input.pointerX - input.startX) * direction
  return {
    width: clamp(rawWidth, minWidth, maxWidth),
    shouldCollapse: maxWidth > 0 && (input.collapsed
      ? rawWidth < minWidth
      : minWidth - rawWidth >= PANEL_CLOSE_OVERSHOOT),
  }
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
