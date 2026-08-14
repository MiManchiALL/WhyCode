import { isTerminalResponseBlock, type Block } from './conversation-state.ts'

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
      forkTurnId: string | null
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

/** 只把已交付最终正文的完整工作暴露给快捷 Fork 入口。 */
export function findLatestForkTurnId(
  sections: readonly ConversationSection[],
): string | null {
  for (let index = sections.length - 1; index >= 0; index--) {
    const section = sections[index]
    if (
      section?.kind === 'completed-work'
      && section.duration.outcome === 'completed'
      && section.finalBlocks.length > 0
    ) {
      return section.forkTurnId
    }
  }
  return null
}

/**
 * 输入区计时只在处理过程仍逐块展开时显示；活动任务摘要已经自带同一计时，
 * 两处不能同时出现。
 */
export function shouldShowComposerProcessingTime(
  workStartedAt: number | null,
  sections: readonly ConversationSection[],
): boolean {
  return workStartedAt !== null
    && !sections.some((section) => section.kind === 'active-work')
}

function appendActiveWork(
  sections: ConversationSection[],
  segment: readonly Block[],
  startedAt: number,
): boolean {
  const { leading, work } = splitLeadingBlocks(segment)
  const finalIndexes = terminalResponseIndexes(work)
  if (finalIndexes.size === 0) return false
  appendBlocks(sections, leading)
  sections.push({
    kind: 'active-work',
    id: workSectionId(work, `active-${startedAt}`),
    startedAt,
    ...sectionBlocks(work, finalIndexes),
  })
  return true
}

function appendCompletedWork(
  sections: ConversationSection[],
  segment: readonly Block[],
  duration: WorkDurationBlock,
): void {
  const { leading, work } = splitLeadingBlocks(segment)
  appendBlocks(sections, leading)
  const finalIndexes = terminalResponseIndexes(work)
  sections.push({
    kind: 'completed-work',
    id: workSectionId(work, duration.id),
    forkTurnId: duration.forkTurnId,
    duration,
    ...sectionBlocks(work, finalIndexes),
  })
}

/**
 * 回滚、压缩等独立通知可能先于下一条用户消息出现。它们不属于随后任务的处理过程，
 * 必须保持在用户消息上方，不能因为工作区投影把时间顺序翻转。
 */
function splitLeadingBlocks(segment: readonly Block[]): {
  leading: readonly Block[]
  work: readonly Block[]
} {
  const userIndex = segment.findIndex((block) => block.kind === 'user')
  return userIndex > 0
    ? { leading: segment.slice(0, userIndex), work: segment.slice(userIndex) }
    : { leading: [], work: segment }
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
  if (!isTerminalResponseBlock(lastBlock)) return new Set()

  const indexes = new Set<number>()
  for (let index = lastIndex; index >= 0; index--) {
    const block = blocks[index]
    if (block?.kind === 'user') break
    if (!isTerminalResponseBlock(block)) break
    indexes.add(index)
  }
  return indexes
}

function appendBlocks(sections: ConversationSection[], blocks: readonly Block[]): void {
  for (const block of blocks) {
    sections.push({ kind: 'block', id: block.id, block })
  }
}
