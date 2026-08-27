import type { Block } from './conversation-state.ts'
import { boundedPlainText } from './conversation-navigation.ts'
import type { ConversationSection } from './conversation-sections.ts'

type UserBlock = Extract<Block, { kind: 'user' }>

export type ConversationDisplayItem =
  | { kind: 'section'; id: string; section: ConversationSection }
  | {
      kind: 'btw-group'
      id: string
      conversationId: string
      summary: string
      sections: Extract<ConversationSection, { kind: 'completed-work' }>[]
    }

export interface BtwConversationPresentation {
  items: ConversationDisplayItem[]
  navigationTargetIds: ReadonlyMap<string, string>
  latestBtwConversationId: string | null
}

/**
 * BTW 链只有在后面出现另一条用户输入后才结束。是否还能 BBTW 不参与展示判断，
 * 因而第三轮完成后也会一直保持展开，直到用户真正选择下一步。
 */
export function presentBtwConversations(
  sections: readonly ConversationSection[],
  expandedIds: ReadonlySet<string>,
): BtwConversationPresentation {
  const latestBtwConversationId = latestUserBlock(sections)?.btw?.conversationId ?? null
  const items: ConversationDisplayItem[] = []
  const navigationTargetIds = new Map<string, string>()

  for (let index = 0; index < sections.length;) {
    const section = sections[index]!
    const conversationId = completedBtwConversationId(section)
    if (!conversationId || conversationId === latestBtwConversationId) {
      items.push({ kind: 'section', id: section.id, section })
      index += 1
      continue
    }

    const grouped: Extract<ConversationSection, { kind: 'completed-work' }>[] = []
    while (index < sections.length) {
      const candidate = sections[index]!
      if (completedBtwConversationId(candidate) !== conversationId) break
      grouped.push(candidate as Extract<ConversationSection, { kind: 'completed-work' }>)
      index += 1
    }

    const id = `btw-conversation-${conversationId}`
    const firstUser = grouped
      .flatMap((item) => item.userBlocks)
      .find((block): block is UserBlock => block.kind === 'user' && block.btw?.turnIndex === 1)
      ?? firstUserBlock(grouped)
    if (!expandedIds.has(id)) {
      for (const block of grouped.flatMap((item) => item.userBlocks)) {
        if (block.kind === 'user') navigationTargetIds.set(block.id, id)
      }
    }
    items.push({
      kind: 'btw-group',
      id,
      conversationId,
      summary: firstUser ? boundedPlainText(firstUser.text, 72) : '临时消息',
      sections: grouped,
    })
  }

  return { items, navigationTargetIds, latestBtwConversationId }
}

function completedBtwConversationId(section: ConversationSection): string | null {
  if (section.kind !== 'completed-work') return null
  const users = section.userBlocks.filter((block): block is UserBlock => block.kind === 'user')
  const conversationId = users[0]?.btw?.conversationId
  if (!conversationId || users.some((block) => block.btw?.conversationId !== conversationId)) {
    return null
  }
  return conversationId
}

function latestUserBlock(sections: readonly ConversationSection[]): UserBlock | null {
  for (let index = sections.length - 1; index >= 0; index--) {
    const users = userBlocks(sections[index]!)
    for (let userIndex = users.length - 1; userIndex >= 0; userIndex--) {
      const block = users[userIndex]
      if (block) return block
    }
  }
  return null
}

function firstUserBlock(
  sections: readonly Extract<ConversationSection, { kind: 'completed-work' }>[],
): UserBlock | null {
  for (const section of sections) {
    const block = section.userBlocks.find((candidate): candidate is UserBlock =>
      candidate.kind === 'user')
    if (block) return block
  }
  return null
}

function userBlocks(section: ConversationSection): UserBlock[] {
  if (section.kind === 'block') {
    return section.block.kind === 'user' ? [section.block] : []
  }
  return section.userBlocks.filter((block): block is UserBlock => block.kind === 'user')
}
