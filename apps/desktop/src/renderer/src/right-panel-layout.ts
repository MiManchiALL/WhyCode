export const RIGHT_PANEL_DEFAULT_WIDTH_RATIO = 0.4
export const RIGHT_PANEL_MIN_WIDTH_RATIO = 0.2
export const RIGHT_PANEL_MAX_WIDTH_RATIO = 0.9
export const RIGHT_PANEL_MIN_CONVERSATION_WIDTH_PX = 420
export const RIGHT_PANEL_CLOSE_OVERSHOOT_PX = 72

const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'whycode:right-panel-width-ratio:v1'
const RIGHT_PANEL_MAX_WIDTH_STORAGE_KEY = 'whycode:right-panel-max-width-ratio:v1'

export interface RightPanelWidthPreference {
  ratio: number
  maximumRatio: number
}

export interface RightPanelWidthBounds {
  minWidth: number
  maxWidth: number
}

export interface RightPanelDragProjection extends RightPanelWidthBounds {
  width: number
  shouldCollapse: boolean
}

export function normalizeRightPanelWidthRatio(value: number): number {
  if (!Number.isFinite(value)) return RIGHT_PANEL_DEFAULT_WIDTH_RATIO
  return clamp(value, RIGHT_PANEL_MIN_WIDTH_RATIO, RIGHT_PANEL_MAX_WIDTH_RATIO)
}

export function parseRightPanelWidthRatio(value: string | null): number {
  if (value === null || value.trim() === '') return RIGHT_PANEL_DEFAULT_WIDTH_RATIO
  return normalizeRightPanelWidthRatio(Number(value))
}

export function parseRightPanelWidthPreference(
  value: string | null,
  maximumValue: string | null,
): RightPanelWidthPreference {
  const ratio = parseRightPanelWidthRatio(value)
  const maximumRatio = maximumValue === null || maximumValue.trim() === ''
    ? ratio
    : normalizeStoredRatio(maximumValue, ratio)
  return {
    ratio: Math.min(ratio, maximumRatio),
    maximumRatio,
  }
}

export function loadRightPanelWidthPreference(): RightPanelWidthPreference {
  try {
    const preference = parseRightPanelWidthPreference(
      globalThis.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY),
      globalThis.localStorage.getItem(RIGHT_PANEL_MAX_WIDTH_STORAGE_KEY),
    )
    globalThis.localStorage.setItem(
      RIGHT_PANEL_WIDTH_STORAGE_KEY,
      String(preference.ratio),
    )
    globalThis.localStorage.setItem(
      RIGHT_PANEL_MAX_WIDTH_STORAGE_KEY,
      String(preference.maximumRatio),
    )
    return preference
  } catch {
    return {
      ratio: RIGHT_PANEL_DEFAULT_WIDTH_RATIO,
      maximumRatio: RIGHT_PANEL_DEFAULT_WIDTH_RATIO,
    }
  }
}

export function persistRightPanelWidthRatio(value: number): void {
  try {
    globalThis.localStorage.setItem(
      RIGHT_PANEL_WIDTH_STORAGE_KEY,
      String(normalizeRightPanelWidthRatio(value)),
    )
  } catch {
    // Renderer 存储不可用时仍保留当前进程内的宽度偏好。
  }
}

export function rightPanelWidthExpression(value: number, maximumRatio: number): string {
  const ratio = Math.min(
    normalizeRightPanelWidthRatio(value),
    normalizeRightPanelWidthRatio(maximumRatio),
  )
  const percent = Number((ratio * 100).toFixed(4))
  return `min(${percent}vw, max(0px, calc(100% - ${RIGHT_PANEL_MIN_CONVERSATION_WIDTH_PX}px)))`
}

export function rightPanelWidthBounds(input: {
  viewportWidth: number
  containerWidth: number
  maximumRatio: number
}): RightPanelWidthBounds {
  const viewportWidth = finiteNonNegative(input.viewportWidth)
  const containerWidth = finiteNonNegative(input.containerWidth)
  const availableWidth = Math.max(0, containerWidth - RIGHT_PANEL_MIN_CONVERSATION_WIDTH_PX)
  const preferredMaximumWidth = viewportWidth * normalizeRightPanelWidthRatio(
    input.maximumRatio,
  )
  const maxWidth = Math.min(availableWidth, preferredMaximumWidth)
  return {
    minWidth: Math.min(viewportWidth * RIGHT_PANEL_MIN_WIDTH_RATIO, maxWidth),
    maxWidth,
  }
}

export function projectRightPanelDrag(input: {
  startX: number
  pointerX: number
  startWidth: number
  viewportWidth: number
  containerWidth: number
  maximumRatio: number
  collapsed: boolean
}): RightPanelDragProjection {
  const bounds = rightPanelWidthBounds(input)
  const rawWidth = finiteNonNegative(input.startWidth)
    + finiteNumber(input.startX)
    - finiteNumber(input.pointerX)
  const shouldCollapse = bounds.maxWidth > 0 && (input.collapsed
    ? rawWidth < bounds.minWidth
    : bounds.minWidth - rawWidth >= RIGHT_PANEL_CLOSE_OVERSHOOT_PX)
  return {
    ...bounds,
    width: clamp(rawWidth, bounds.minWidth, bounds.maxWidth),
    shouldCollapse,
  }
}

export function rightPanelRatioFromWidth(width: number, viewportWidth: number): number {
  const safeViewportWidth = finiteNonNegative(viewportWidth)
  if (safeViewportWidth === 0) return RIGHT_PANEL_DEFAULT_WIDTH_RATIO
  return normalizeRightPanelWidthRatio(finiteNonNegative(width) / safeViewportWidth)
}

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function finiteNonNegative(value: number): number {
  return Math.max(0, finiteNumber(value))
}

function normalizeStoredRatio(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? normalizeRightPanelWidthRatio(parsed) : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}
