import type { Block } from './conversation-state.ts'
import type { ConversationSection } from './conversation-sections.ts'

export const CONVERSATION_NAVIGATION_SLOT_PX = 12
export const CONVERSATION_NAVIGATION_MAX_RENDERED = 42
const CONVERSATION_NAVIGATION_OVERSCAN = 1
const CONVERSATION_NAVIGATION_MAX_VISIBLE = CONVERSATION_NAVIGATION_MAX_RENDERED
  - CONVERSATION_NAVIGATION_OVERSCAN * 2

type UserBlock = Extract<Block, { kind: 'user' }>

export interface ConversationNavigationEntry {
  id: string
  title: string
  preview: string | null
  isBtw: boolean
}

export interface ConversationNavigationMarker {
  entryIndex: number
  y: number
  edgeOpacity: number
}

interface ConversationNavigationWindow {
  normalizedOffset: number
  origin: number
  first: number
  last: number
}

/** 每个用户输入只投影一条有界纯文本预览，不复制整段时间线或 Markdown 树。 */
export function conversationNavigationEntries(
  sections: readonly ConversationSection[],
): ConversationNavigationEntry[] {
  const entries: ConversationNavigationEntry[] = []
  for (const section of sections) {
    if (section.kind === 'block') {
      if (section.block.kind === 'user') entries.push(entryForUser(section.block, null))
      continue
    }
    const preview = section.kind === 'completed-work'
      ? assistantPreview(section.finalBlocks) ?? assistantPreview(section.activityBlocks)
      : null
    for (const block of section.userBlocks) {
      if (block.kind === 'user') entries.push(entryForUser(block, preview))
    }
  }
  return entries
}

export function conversationNavigationCapacity(height: number): number {
  if (!Number.isFinite(height) || height <= 0) return 1
  return Math.max(1, Math.min(
    CONVERSATION_NAVIGATION_MAX_VISIBLE,
    Math.floor(height / CONVERSATION_NAVIGATION_SLOT_PX),
  ))
}

export function conversationNavigationMaxOffset(
  entryCount: number,
  height: number,
): number {
  return Math.max(0, entryCount - conversationNavigationCapacity(height))
}

export function clampConversationNavigationOffset(
  offset: number,
  entryCount: number,
  height: number,
): number {
  return clamp(offset, 0, conversationNavigationMaxOffset(entryCount, height))
}

export function centeredConversationNavigationOffset(
  entryIndex: number,
  entryCount: number,
  height: number,
): number {
  const capacity = conversationNavigationCapacity(height)
  return clampConversationNavigationOffset(
    entryIndex - (capacity - 1) / 2,
    entryCount,
    height,
  )
}

/** 手动浏览时只收敛到新边界；否则让定位轨跟随正文当前项。 */
export function reconcileConversationNavigationOffset(
  currentOffset: number,
  currentIndex: number,
  entryCount: number,
  height: number,
  preserveCurrentOffset: boolean,
): number {
  return preserveCurrentOffset
    ? clampConversationNavigationOffset(currentOffset, entryCount, height)
    : centeredConversationNavigationOffset(currentIndex, entryCount, height)
}

/** 轨道滚轮只在指针真实命中可见锚点且确有隐藏条目时接管。 */
export function conversationNavigationWheelEnabled(
  pointerInside: boolean,
  pointerY: number | null,
  entryCount: number,
  height: number,
): boolean {
  return pointerInside
    && pointerY !== null
    && conversationNavigationMaxOffset(entryCount, height) > 0
}

export function conversationNavigationIndexAtY(
  y: number,
  offset: number,
  entryCount: number,
  height: number,
): number | null {
  if (!Number.isFinite(y) || entryCount <= 0 || height <= 0 || y < 0 || y > height) {
    return null
  }
  const navigationWindow = conversationNavigationWindow(entryCount, height, offset)
  if (!navigationWindow) return null
  const index = Math.round(
    navigationWindow.normalizedOffset
      + (y - navigationWindow.origin) / CONVERSATION_NAVIGATION_SLOT_PX,
  )
  if (index < navigationWindow.first || index > navigationWindow.last) return null
  const markerY = navigationWindow.origin
    + (index - navigationWindow.normalizedOffset) * CONVERSATION_NAVIGATION_SLOT_PX
  return markerY >= 0
    && markerY <= height
    && Math.abs(y - markerY) <= CONVERSATION_NAVIGATION_SLOT_PX / 2
    ? index
    : null
}

export function conversationNavigationWaveIndexAtY(
  y: number,
  offset: number,
  entryCount: number,
  height: number,
): number {
  if (entryCount <= 0) return 0
  const origin = navigationOriginY(entryCount, height)
  return clamp(
    clampConversationNavigationOffset(offset, entryCount, height)
      + (clamp(y, 0, height) - origin) / CONVERSATION_NAVIGATION_SLOT_PX,
    0,
    entryCount - 1,
  )
}

/** 只返回视口和一格 overscan，长会话不会创建与历史长度等量的节点。 */
export function visibleConversationNavigationMarkers(
  entryCount: number,
  height: number,
  offset: number,
): ConversationNavigationMarker[] {
  const navigationWindow = conversationNavigationWindow(entryCount, height, offset)
  if (!navigationWindow) return []
  const { first, last, normalizedOffset, origin } = navigationWindow
  const hasHiddenBefore = first > 0
  const hasHiddenAfter = last < entryCount - 1
  const markers: ConversationNavigationMarker[] = []
  for (let entryIndex = first; entryIndex <= last; entryIndex++) {
    const y = origin
      + (entryIndex - normalizedOffset) * CONVERSATION_NAVIGATION_SLOT_PX
    if (y < -CONVERSATION_NAVIGATION_SLOT_PX || y > height + CONVERSATION_NAVIGATION_SLOT_PX) {
      continue
    }
    const edgeDistance = Math.min(
      hasHiddenBefore ? entryIndex - first : Number.POSITIVE_INFINITY,
      hasHiddenAfter ? last - entryIndex : Number.POSITIVE_INFINITY,
    )
    markers.push({
      entryIndex,
      y,
      edgeOpacity: Number.isFinite(edgeDistance)
        ? clamp(edgeDistance / 2.75, 0.12, 1)
        : 1,
    })
  }
  return markers
}

export function conversationNavigationEntryY(
  entryIndex: number,
  entryCount: number,
  height: number,
  offset: number,
): number {
  return navigationOriginY(entryCount, height)
    + (entryIndex - clampConversationNavigationOffset(offset, entryCount, height))
      * CONVERSATION_NAVIGATION_SLOT_PX
}

/** 连续距离形成波峰；基础长度仍保留相邻刻度的轻微长短差。 */
export function conversationNavigationMarkerWidth(
  entryIndex: number,
  waveIndex: number | null,
): number {
  const base = entryIndex % 2 === 0 ? 9 : 7
  if (waveIndex === null) return base
  const distance = Math.abs(entryIndex - waveIndex)
  const influence = Math.max(0, 1 - distance / 4)
  return base + (34 - base) * influence * influence
}

/** 活动步骤的 token/tool 增量不改变定位数据，不让刻度跟随正文流重渲染。 */
export function sameConversationNavigationTimeline(
  previous: readonly ConversationSection[],
  next: readonly ConversationSection[],
): boolean {
  if (previous === next) return true
  if (previous.length !== next.length) return false
  for (let index = 0; index < previous.length; index++) {
    const left = previous[index]!
    const right = next[index]!
    if (left.kind !== right.kind) return false
    if (left.kind === 'block' && right.kind === 'block') {
      if (!sameStandaloneUser(left.block, right.block)) return false
      continue
    }
    if (left.kind === 'block' || right.kind === 'block') return false
    if (!sameUserBlocks(left.userBlocks, right.userBlocks)) return false
    if (left.kind === 'completed-work' && right.kind === 'completed-work') {
      const leftPreview = previewBlock(left.finalBlocks) ?? previewBlock(left.activityBlocks)
      const rightPreview = previewBlock(right.finalBlocks) ?? previewBlock(right.activityBlocks)
      if (!samePreviewBlock(leftPreview, rightPreview)) return false
    }
  }
  return true
}

function navigationOriginY(entryCount: number, height: number): number {
  const visible = Math.min(entryCount, conversationNavigationCapacity(height))
  const span = Math.max(0, visible - 1) * CONVERSATION_NAVIGATION_SLOT_PX
  return Math.max(0, (height - span) / 2)
}

function conversationNavigationWindow(
  entryCount: number,
  height: number,
  offset: number,
): ConversationNavigationWindow | null {
  if (entryCount <= 0 || height <= 0) return null
  const capacity = conversationNavigationCapacity(height)
  const normalizedOffset = clampConversationNavigationOffset(offset, entryCount, height)
  const firstVisible = Math.ceil(normalizedOffset)
  return {
    normalizedOffset,
    origin: navigationOriginY(entryCount, height),
    first: Math.max(0, firstVisible - CONVERSATION_NAVIGATION_OVERSCAN),
    last: Math.min(
      entryCount - 1,
      firstVisible + capacity - 1 + CONVERSATION_NAVIGATION_OVERSCAN,
    ),
  }
}

function entryForUser(
  block: UserBlock,
  preview: string | null,
): ConversationNavigationEntry {
  return {
    id: block.id,
    title: boundedPlainText(block.text, 72) || attachmentLabel(block),
    preview,
    isBtw: block.btw !== undefined,
  }
}

function assistantPreview(blocks: readonly Block[]): string | null {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (!block) continue
    const text = block.kind === 'text' || block.kind === 'notice' || block.kind === 'error'
      ? block.text
      : null
    if (!text) continue
    const preview = boundedPlainText(text, 150)
    if (preview) return preview
  }
  return null
}

function attachmentLabel(block: UserBlock): string {
  const images = block.attachments?.length ?? 0
  const pdfs = block.pdfAttachments?.length ?? 0
  if (images > 0 && pdfs > 0) return '包含图片和 PDF 的消息'
  if (images > 0) return '图片消息'
  if (pdfs > 0) return 'PDF 消息'
  if (block.skills?.length) return '使用 Skill 的消息'
  return '用户消息'
}

function sameStandaloneUser(left: Block, right: Block): boolean {
  if (left.kind !== 'user' || right.kind !== 'user') {
    return left.kind !== 'user' && right.kind !== 'user'
  }
  return sameUser(left, right)
}

function sameUserBlocks(left: readonly Block[], right: readonly Block[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    const leftBlock = left[index]
    const rightBlock = right[index]
    if (!leftBlock || !rightBlock || !sameUser(leftBlock, rightBlock)) return false
  }
  return true
}

function sameUser(left: Block, right: Block): boolean {
  return left.kind === 'user'
    && right.kind === 'user'
    && left.id === right.id
    && left.text === right.text
    && left.attachments?.length === right.attachments?.length
    && left.pdfAttachments?.length === right.pdfAttachments?.length
    && left.skills?.length === right.skills?.length
    && left.btw?.conversationId === right.btw?.conversationId
    && left.btw?.turnIndex === right.btw?.turnIndex
    && left.btw?.mode === right.btw?.mode
}

function previewBlock(blocks: readonly Block[]): Block | undefined {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block?.kind === 'text' || block?.kind === 'notice' || block?.kind === 'error') {
      return block
    }
  }
  return undefined
}

function samePreviewBlock(left: Block | undefined, right: Block | undefined): boolean {
  if (left === right) return true
  if (!left || !right || left.kind !== right.kind || left.id !== right.id) return false
  return 'text' in left && 'text' in right && left.text === right.text
}

export function boundedPlainText(text: string, maximum: number): string {
  const bounded = text.slice(0, maximum * 4)
  const normalized = bounded
    .replace(/```[\s\S]*?```/g, ' 代码片段 ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (normalized.length <= maximum) return normalized
  return `${normalized.slice(0, maximum).trimEnd()}…`
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}
