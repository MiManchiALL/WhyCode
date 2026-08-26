import { z } from 'zod'
import type { ImageAttachment } from '../attachments/types.ts'

export const BTW_MAX_TURNS = 3
export const btwModeSchema = z.enum(['btw', 'bbtw'])
export type BtwMode = z.infer<typeof btwModeSchema>

export interface BtwCompletedTurn {
  inputId: string
  conversationId: string
  turnIndex: number
  mode: BtwMode
  text: string
  attachments: ImageAttachment[]
  assistantText: string
}

export interface BtwContinuation {
  conversationId: string
  turns: BtwCompletedTurn[]
}

export interface BtwTurnContext {
  inputId: string
  conversationId: string
  turnIndex: number
  mode: BtwMode
  text: string
  attachments: ImageAttachment[]
  history: BtwCompletedTurn[]
}

export interface BtwTurnResult {
  outcome: 'completed' | 'stopped' | 'error'
  assistantText: string
  reasoningText: string
  reasoningDurationMs: number
  durationMs: number
  error?: string
}
