import { isTerminalResponseBlock, workSectionId, type Block } from './conversation-state.ts'

type WorkDurationBlock = Extract<Block, { kind: 'work-duration' }>

export type ConversationSection =
  | { kind: 'block'; id: string; block: Block }
  | {
      kind: 'active-work'
      id: string
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
  // 中断后再试的横条跟随实际重试位置。原始块仍保留，历史分页和回滚使用稳定索引。
  const superseded = new Set<Block>()
  let previous: Extract<Block, { kind: 'compaction' }> | undefined
  for (const block of blocks) {
    if (block.kind !== 'compaction') continue
    if (previous && previous.status !== 'completed' && previous.index === block.index) superseded.add(previous)
    previous = block
  }
  if (superseded.size) blocks = blocks.filter(block => !superseded.has(block))
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
      && section.forkTurnId !== null
    ) {
      return section.forkTurnId
    }
  }
  return null
}

/** Fork 分隔线只标记子会话的真实来源；两个缺失的 ID 不构成匹配。 */
export function isForkBoundarySection(
  section: ConversationSection,
  forkSourceTurnId: string | null,
): boolean {
  return forkSourceTurnId !== null
    && section.kind === 'completed-work'
    && section.forkTurnId === forkSourceTurnId
}

/** 仅文件回滚标记跟随对应用户 turn，独立于该 turn 的处理过程展开状态。 */
export function isFileRollbackBoundarySection(
  section: ConversationSection,
  turnId: string | null,
): boolean {
  if (turnId === null) return false
  if (section.kind === 'block') {
    return section.block.kind === 'user' && section.block.turnId === turnId
  }
  return section.userBlocks.some((block) =>
    block.kind === 'user' && block.turnId === turnId)
}

/**
 * 工作结束或最终正文出现时封口末尾工具批次；是否展开整个执行过程仍由
 * ConversationState.expanded 独立决定。
 */
export function shouldSealTrailingToolBatch(
  section: Extract<ConversationSection, { kind: 'active-work' | 'completed-work' }>,
): boolean {
  return section.kind === 'completed-work'
    || section.finalBlocks.some((block) => block.kind === 'text')
}

function appendActiveWork(
  sections: ConversationSection[],
  segment: readonly Block[],
  startedAt: number,
): boolean {
  const { leading, work } = splitLeadingBlocks(segment)
  if (!work.some(isTerminalResponseBlock)) return false
  appendBlocks(sections, leading)
  sections.push({
    kind: 'active-work',
    id: workSectionId(work[0], `active-${startedAt}`),
    ...sectionBlocks(work),
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
  sections.push({
    kind: 'completed-work',
    id: workSectionId(work[0], duration.id),
    forkTurnId: duration.forkTurnId,
    duration,
    ...sectionBlocks(work),
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
): Pick<
  Extract<ConversationSection, { kind: 'active-work' }>,
  'userBlocks' | 'activityBlocks' | 'finalBlocks'
> {
  return {
    userBlocks: segment.filter((block) => block.kind === 'user'),
    activityBlocks: segment.filter(block => block.kind !== 'user' && !isTerminalResponseBlock(block)),
    finalBlocks: segment.filter(isTerminalResponseBlock),
  }
}

function appendBlocks(sections: ConversationSection[], blocks: readonly Block[]): void {
  for (const block of blocks) {
    sections.push({ kind: 'block', id: block.id, block })
  }
}
