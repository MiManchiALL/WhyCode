import { z } from 'zod'
import type { ImageAttachment } from '../attachments/types.ts'
import type { TurnInterruptionReason } from './interruption.ts'

export const BTW_MAX_TURNS = 3
export const btwModeSchema = z.enum(['btw', 'bbtw'])
export type BtwMode = z.infer<typeof btwModeSchema>

export type BtwInterruptionReason = Extract<
  TurnInterruptionReason,
  'user-cancel' | 'process-interruption'
>

export interface BtwConversationTurn {
  inputId: string
  conversationId: string
  turnIndex: number
  mode: BtwMode
  text: string
  attachments: ImageAttachment[]
  outcome: 'completed' | 'stopped' | 'error'
  assistantText: string
  interruptionReason?: BtwInterruptionReason
  error?: string
}

export interface BtwConversation {
  conversationId: string
  turns: BtwConversationTurn[]
}

export type BtwContinuation = BtwConversation

export interface BtwTurnContext {
  inputId: string
  conversationId: string
  turnIndex: number
  mode: BtwMode
  text: string
  attachments: ImageAttachment[]
  history: BtwConversationTurn[]
  replacesInputId?: string
}

export interface BtwTurnResult {
  outcome: 'completed' | 'stopped' | 'error'
  assistantText: string
  reasoningText: string
  reasoningDurationMs: number
  durationMs: number
  interruptionReason?: BtwInterruptionReason
  error?: string
}

export interface BtwTurnSettlement {
  continuationAvailable: boolean
}

export function canContinueBtw(
  conversation: BtwConversation | null,
): conversation is BtwConversation {
  if (!conversation) return false
  const latest = conversation.turns.at(-1)
  return Boolean(latest && latest.outcome !== 'error' && conversation.turns.length < BTW_MAX_TURNS)
}
