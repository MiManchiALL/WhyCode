import { modelMessageSchema } from 'ai'
import { z } from 'zod'
import { truncateVisibleToolOutput, type CoreEvent } from '../events.ts'
import { toolOutputText } from '../attachments/tool-results.ts'
import { pdfAttachmentsSchema } from '../pdf/types.ts'
import type { ImageAttachment } from '../attachments/types.ts'
import type { TurnInterruptionReason } from './interruption.ts'

export const BTW_MAX_TURNS = 3
export const btwModeSchema = z.enum(['btw', 'bbtw'])
export type BtwMode = z.infer<typeof btwModeSchema>

export const btwToolStepSchema = z.object({
  messages: z.array(modelMessageSchema),
  reasoningDurationMs: z.number().nonnegative(),
  toolErrors: z.array(z.string()),
  pdfAttachments: pdfAttachmentsSchema.optional(),
})
export type BtwToolStep = z.infer<typeof btwToolStepSchema>

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
  toolSteps?: BtwToolStep[]
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
  toolSteps?: BtwToolStep[]
  reasoningText: string
  reasoningDurationMs: number
  durationMs: number
  interruptionReason?: BtwInterruptionReason
  error?: string
}

type BtwToolEvent = Extract<CoreEvent, {
  type: 'text-delta' | 'thinking-delta' | 'thinking-end' | 'tool-start' | 'tool-end'
}>

export function btwToolStepEvents(steps: readonly BtwToolStep[]): BtwToolEvent[] {
  return steps.flatMap((step) => {
    const events: BtwToolEvent[] = []
    let reasoningEnded = false
    for (const message of step.messages) {
      if (message.role !== 'assistant' && message.role !== 'tool') continue
      if (!Array.isArray(message.content)) continue
      for (const part of message.content) {
        if (part.type === 'text') events.push({ type: 'text-delta', text: part.text })
        if (part.type === 'reasoning') {
          events.push({ type: 'thinking-delta', text: part.text })
          events.push({ type: 'thinking-end', durationMs: reasoningEnded ? 0 : step.reasoningDurationMs })
          reasoningEnded = true
        }
        if (part.type === 'tool-call') events.push({
          type: 'tool-start', toolUseId: part.toolCallId, toolName: part.toolName,
          input: part.input as Record<string, unknown>,
        })
        if (part.type === 'tool-result') events.push({
          type: 'tool-end', toolUseId: part.toolCallId,
          result: truncateVisibleToolOutput(toolOutputText(part.output)),
          isError: step.toolErrors.includes(part.toolCallId)
            || part.output.type === 'error-text' || part.output.type === 'error-json',
        })
      }
    }
    return events
  })
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
