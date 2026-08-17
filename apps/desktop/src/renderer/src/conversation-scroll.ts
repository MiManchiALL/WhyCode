import {
  captureScrollPosition,
  restoredAnchorScrollTop,
  restoredScrollTop,
  type ConversationScrollAnchor,
  type ConversationScrollPosition,
} from './conversation-presentation.ts'

const SECTION_SELECTOR = '[data-conversation-scroll-section]'
const BLOCK_SELECTOR = '[data-conversation-scroll-block]'

interface MaterializedSection {
  element: HTMLElement
  contentVisibility: string
  contain: string
}

export function captureConversationScrollPosition(
  scroller: HTMLElement,
): ConversationScrollPosition {
  const position = captureScrollPosition(scroller)
  if (position.atBottom) return position
  const anchor = captureConversationScrollAnchor(scroller)
  return anchor ? { ...position, anchor } : position
}

export function restoreConversationScrollPosition(
  position: ConversationScrollPosition,
  scroller: HTMLElement,
): ConversationScrollPosition {
  const savedAnchor = position.atBottom ? undefined : position.anchor
  const section = savedAnchor
    ? findByDataValue(scroller, SECTION_SELECTOR, 'conversationScrollSection', savedAnchor.sectionId)
    : null
  if (!savedAnchor || !section) {
    scroller.scrollTop = restoredScrollTop(position, scroller)
    return captureScrollPosition(scroller)
  }

  const materialized = materializeSectionsThrough(scroller, section)
  try {
    const anchor = resolveScrollAnchor(section, savedAnchor)
    const anchorTop = elementTopWithinScroller(scroller, anchor)
    const desiredScrollTop = Math.max(0, anchorTop + savedAnchor.offset)
    materializeTailUntilScrollable(scroller, section, desiredScrollTop, materialized)
    scroller.scrollTop = restoredAnchorScrollTop(
      anchorTop,
      savedAnchor.offset,
      scroller,
    )
  } finally {
    finalizeMaterializedSections(materialized)
  }
  return captureScrollPosition(scroller)
}

function captureConversationScrollAnchor(
  scroller: HTMLElement,
): ConversationScrollAnchor | undefined {
  const viewportTop = scroller.getBoundingClientRect().top
  const section = elementAtViewport(
    scroller.querySelectorAll<HTMLElement>(SECTION_SELECTOR),
    viewportTop,
  )
  const sectionId = section?.dataset.conversationScrollSection
  if (!section || !sectionId) return undefined

  const block = elementAtViewport(
    section.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
    viewportTop,
  )
  const blockId = block?.dataset.conversationScrollBlock
  const contentAnchors = block ? markdownContentAnchors(block) : []
  const content = elementAtViewport(contentAnchors, viewportTop)
  const anchor = content ?? block ?? section
  const contentIndex = content ? contentAnchors.indexOf(content) : -1
  return {
    sectionId,
    ...(blockId ? { blockId } : {}),
    ...(contentIndex >= 0 ? { contentIndex } : {}),
    offset: viewportTop - anchor.getBoundingClientRect().top,
  }
}

function resolveScrollAnchor(
  section: HTMLElement,
  anchor: ConversationScrollAnchor,
): HTMLElement {
  if (!anchor.blockId) return section
  const block = findByDataValue(
    section,
    BLOCK_SELECTOR,
    'conversationScrollBlock',
    anchor.blockId,
  )
  if (!block || anchor.contentIndex === undefined) return block ?? section
  return markdownContentAnchors(block)[anchor.contentIndex] ?? block
}

function markdownContentAnchors(block: HTMLElement): HTMLElement[] {
  const streamdownRoot = block.querySelector<HTMLElement>('.wc-markdown')?.firstElementChild
  return streamdownRoot
    ? Array.from(streamdownRoot.children) as HTMLElement[]
    : []
}

function elementAtViewport(
  elements: Iterable<HTMLElement>,
  viewportTop: number,
): HTMLElement | null {
  let selected: HTMLElement | null = null
  for (const element of elements) {
    if (!selected) selected = element
    if (element.getBoundingClientRect().top > viewportTop + 1) break
    selected = element
  }
  return selected
}

function findByDataValue(
  root: HTMLElement,
  selector: string,
  key: 'conversationScrollSection' | 'conversationScrollBlock',
  value: string,
): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (element.dataset[key] === value) return element
  }
  return null
}

function materializeSectionsThrough(
  scroller: HTMLElement,
  target: HTMLElement,
): MaterializedSection[] {
  const materialized: MaterializedSection[] = []
  for (const section of scroller.querySelectorAll<HTMLElement>(SECTION_SELECTOR)) {
    materializeSection(section, materialized)
    if (section === target) break
  }
  return materialized
}

function materializeTailUntilScrollable(
  scroller: HTMLElement,
  target: HTMLElement,
  desiredScrollTop: number,
  materialized: MaterializedSection[],
): void {
  if (maximumScrollTop(scroller) >= desiredScrollTop) return
  let afterTarget = false
  for (const section of scroller.querySelectorAll<HTMLElement>(SECTION_SELECTOR)) {
    if (!afterTarget) {
      afterTarget = section === target
      continue
    }
    materializeSection(section, materialized)
    if (maximumScrollTop(scroller) >= desiredScrollTop) return
  }
}

function materializeSection(
  section: HTMLElement,
  materialized: MaterializedSection[],
): void {
  if (!section.classList.contains('wc-completed-work-section')) return
  materialized.push({
    element: section,
    contentVisibility: section.style.getPropertyValue('content-visibility'),
    contain: section.style.getPropertyValue('contain'),
  })
  section.style.setProperty('content-visibility', 'visible')
  section.style.setProperty('contain', 'layout style paint')
}

function finalizeMaterializedSections(materialized: MaterializedSection[]): void {
  const measuredHeights = materialized.map(({ element }) => (
    element.getBoundingClientRect().height
  ))
  for (const [index, { element }] of materialized.entries()) {
    const height = measuredHeights[index]!
    if (height > 0) {
      element.style.setProperty('contain-intrinsic-block-size', `auto ${height}px`)
    }
  }
  for (const { element, contain } of materialized) {
    if (contain) element.style.setProperty('contain', contain)
    else element.style.removeProperty('contain')
  }
  for (const { element, contentVisibility } of materialized) {
    if (contentVisibility) {
      element.style.setProperty('content-visibility', contentVisibility)
    } else {
      element.style.removeProperty('content-visibility')
    }
  }
}

function elementTopWithinScroller(scroller: HTMLElement, element: HTMLElement): number {
  return scroller.scrollTop
    + element.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top
}

function maximumScrollTop(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight)
}
