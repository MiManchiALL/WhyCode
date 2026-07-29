import type { Block } from './conversation-state.ts'

type WorkDurationBlock = Extract<Block, { kind: 'work-duration' }>

export type ConversationSection =
  | { kind: 'block'; id: string; block: Block }
  | {
      kind: 'completed-work'
      id: string
      duration: WorkDurationBlock
      userBlocks: Block[]
      activityBlocks: Block[]
      finalBlocks: Block[]
    }

/**
 * 把稳定时间线投影为“用户消息 / 处理过程 / 最终回答”三层；原始 Block 顺序和
 * ViewEvent 仍是唯一事实源，展开状态也继续复用 ConversationState.expanded。
 */
export function conversationSections(blocks: readonly Block[]): ConversationSection[] {
  const sections: ConversationSection[] = []
  let segmentStart = 0

  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index]
    if (block?.kind !== 'work-duration') continue

    appendCompletedWork(sections, blocks.slice(segmentStart, index), block)
    segmentStart = index + 1
  }

  appendBlocks(sections, blocks.slice(segmentStart))
  return sections
}

function appendCompletedWork(
  sections: ConversationSection[],
  segment: readonly Block[],
  duration: WorkDurationBlock,
): void {
  const finalIndexes = terminalResponseIndexes(segment)
  sections.push({
    kind: 'completed-work',
    id: duration.id,
    duration,
    userBlocks: segment.filter((block) => block.kind === 'user'),
    activityBlocks: segment.filter((block, index) =>
      block.kind !== 'user' && !finalIndexes.has(index)),
    finalBlocks: segment.filter((_block, index) => finalIndexes.has(index)),
  })
}

function terminalResponseIndexes(blocks: readonly Block[]): ReadonlySet<number> {
  const lastIndex = blocks.findLastIndex((block) =>
    block.kind === 'text' || block.kind === 'error')
  if (lastIndex < 0) return new Set()

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
