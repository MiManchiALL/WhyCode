import type { ModelMessage } from 'ai'
import { z } from 'zod'

export const RECENT_PDF_USER_TURNS = 3
const pdfTurnSchema = z.object({ id: z.string().min(1), pdfIds: z.array(z.string().uuid()) }).strict()
export const conversationMetadataSchema = z.object({
  userTurn: pdfTurnSchema.extend({ startsTurn: z.boolean() }).optional(),
  recentUserTurns: z.array(pdfTurnSchema).max(RECENT_PDF_USER_TURNS).optional(),
}).strict()
type ConversationMetadata = z.infer<typeof conversationMetadataSchema>
export type PdfUserTurn = z.infer<typeof pdfTurnSchema>
type ConversationMessage = ModelMessage & { whycode?: ConversationMetadata }

/** 宿主输入入口提供身份；不从 role、提示词标签或自然语言猜测正式 turn。 */
export function withUserTurn(
  message: ModelMessage, id: string, startsTurn: boolean, pdfIds: Iterable<string> = [],
): ModelMessage {
  return { ...message, whycode: { userTurn: { id, pdfIds: [...pdfIds], startsTurn } } } as ConversationMessage
}

export function userTurn(message: ModelMessage): ConversationMetadata['userTurn'] {
  return (message as ConversationMessage).whycode?.userTurn
}

export function latestUserTurnIndex(messages: readonly ModelMessage[]): number {
  return messages.findLastIndex(message => userTurn(message)?.startsTurn === true)
}

/** 压缩只携带最近三个 turn 的附件身份，不复制用户正文或回滚锚点。 */
export function recentPdfUserTurns(messages: readonly ModelMessage[]): PdfUserTurn[] {
  const turns = new Map<string, Set<string>>()
  for (const message of messages) {
    const metadata = (message as ConversationMessage).whycode
    for (const turn of metadata?.recentUserTurns ?? []) turns.set(turn.id, new Set(turn.pdfIds))
    const turn = metadata?.userTurn
    if (turn) {
      if (turn.startsTurn && !turns.has(turn.id)) turns.set(turn.id, new Set())
      const pdfs = turns.get(turn.id)
      for (const id of turn.pdfIds) pdfs?.add(id)
    }
    while (turns.size > RECENT_PDF_USER_TURNS) turns.delete(turns.keys().next().value!)
  }
  return [...turns].map(([id, pdfIds]) => ({ id, pdfIds: [...pdfIds] }))
}

export function recentUserPdfIds(messages: readonly ModelMessage[]): Set<string> {
  return new Set(recentPdfUserTurns(messages).flatMap(turn => turn.pdfIds))
}

export function carryRecentPdfTurns(message: ModelMessage, source: readonly ModelMessage[]): ModelMessage {
  return {
    ...message,
    whycode: { ...(message as ConversationMessage).whycode, recentUserTurns: recentPdfUserTurns(source) },
  } as ConversationMessage
}

/** 元数据随 canonical messages 持久化，但绝不作为 Provider 参数或提示词发送。 */
export function withoutConversationMetadata(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map(message => {
    const { whycode: _metadata, ...plain } = message as ConversationMessage
    return plain as ModelMessage
  })
}
