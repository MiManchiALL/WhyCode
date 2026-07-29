import type { Block } from './conversation-state.ts'

type WorkDurationBlock = Extract<Block, { kind: 'work-duration' }>

export type ConversationSection =
  | { kind: 'block'; id: string; block: Block }
  | {
      kind: 'active-work'
      id: string
      startedAt: number
      userBlocks: Block[]
      activityBlocks: Block[]
      finalBlocks: Block[]
    }
  | {
      kind: 'completed-work'
      id: string
      duration: WorkDurationBlock
      userBlocks: Block[]
      activityBlocks: Block[]
      finalBlocks: Block[]
    }

/**
 * 把原始时间线投影为“用户消息 / 处理过程 / 最终回答”三层；Block 顺序和
 * ViewEvent 仍是唯一事实源，展开状态也继续复用 ConversationState.expanded。
 */
export function conversationSections(
  blocks: readonly Block[],
  activeWorkStartedAt: number | null = null,
): ConversationSection[] {
  const sections: ConversationSection[] = []
  let segmentStart = 0

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block?.kind !== 'work-duration') continue

    appendCompletedWork(sections, blocks.slice(segmentStart, index), block)
    segmentStart = index + 1
  }

  const tail = blocks.slice(segmentStart)
  if (activeWorkStartedAt === null || !appendActiveWork(sections, tail, activeWorkStartedAt)) {
    appendBlocks(sections, tail)
  }
  return sections
}

function appendActiveWork(
  sections: ConversationSection[],
  segment: readonly Block[],
  startedAt: number,
): boolean {
  const finalIndexes = terminalResponseIndexes(segment)
  if (finalIndexes.size === 0) return false
  sections.push({
    kind: 'active-work',
    id: workSectionId(segment, `active-${startedAt}`),
    startedAt,
    ...sectionBlocks(segment, finalIndexes),
  })
  return true
}

function appendCompletedWork(
  sections: ConversationSection[],
  segment: readonly Block[],
  duration: WorkDurationBlock,
): void {
  const finalIndexes = terminalResponseIndexes(segment)
  sections.push({
    kind: 'completed-work',
    id: workSectionId(segment, duration.id),
    duration,
    ...sectionBlocks(segment, finalIndexes),
  })
}

function sectionBlocks(
  segment: readonly Block[],
  finalIndexes: ReadonlySet<number>,
): Pick<
  Extract<ConversationSection, { kind: 'active-work' }>,
  'userBlocks' | 'activityBlocks' | 'finalBlocks'
> {
  return {
    userBlocks: segment.filter((block) => block.kind === 'user'),
    activityBlocks: segment.filter((block, index) =>
      block.kind !== 'user' && !finalIndexes.has(index)),
    finalBlocks: segment.filter((_block, index) => finalIndexes.has(index)),
  }
}

function workSectionId(segment: readonly Block[], boundaryId: string): string {
  return `work-${segment[0]?.id ?? boundaryId}`
}

function terminalResponseIndexes(blocks: readonly Block[]): ReadonlySet<number> {
  const lastIndex = blocks.length - 1
  const lastBlock = blocks[lastIndex]
  if (lastBlock?.kind !== 'text' && lastBlock?.kind !== 'error') return new Set()

  const indexes = new Set<number>()
  for (let index = lastIndex; index >= 0; index--) {
    const block = blocks[index]
    if (block?.kind === 'user') break
    if (block?.kind !== 'text' && block?.kind !== 'error') break
    indexes.add(index)
  }
  return indexes
}

function appendBlocks(sections: ConversationSection[], blocks: readonly Block[]): void {
  for (const block of blocks) {
    sections.push({ kind: 'block', id: block.id, block })
  }
}
