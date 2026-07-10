import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import { taskPlanSchema } from '../tasks/types.ts'

const toolStartSchema = z.object({
  type: z.literal('tool-start'),
  toolUseId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
})

const toolProgressSchema = z.object({
  type: z.literal('tool-progress'),
  toolUseId: z.string(),
  output: z.string(),
})

const toolEndSchema = z.object({
  type: z.literal('tool-end'),
  toolUseId: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
})

const peerInnerEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  toolStartSchema,
  toolEndSchema,
])

const candidateDetailsSchema = z.object({
  finalAnswerOrPlan: z.string(),
  evidenceRefs: z.array(z.string()).optional(),
  knownRisks: z.array(z.string()).optional(),
})

const userQuestionSchema = z.object({
  id: z.string().min(1),
  header: z.string().min(1),
  question: z.string().min(1),
  options: z
    .array(z.object({ label: z.string().min(1), description: z.string().min(1) }))
    .min(2)
    .max(4),
})

export const visibleCoreEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn-start'), turnId: z.string() }),
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('thinking-delta'), text: z.string() }),
  z.object({ type: z.literal('thinking-end'), durationMs: z.number().nonnegative() }),
  toolStartSchema,
  toolProgressSchema,
  toolEndSchema,
  z.object({
    type: z.literal('checkpoint-created'),
    toolUseId: z.string(),
    hash: z.string(),
    coverage: z.enum(['complete', 'partial']),
    warning: z.string().optional(),
  }),
  z.object({ type: z.literal('checkpoint-disabled'), reason: z.string() }),
  z.object({
    type: z.literal('checkpoint-restored'),
    toolUseId: z.string(),
    turnId: z.string(),
    scope: z.enum(['files', 'files-and-chat']),
    ok: z.boolean(),
    error: z.string().optional(),
    invalidatedToolUseIds: z.array(z.string()).optional(),
    taskPlan: taskPlanSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal('context-compacted'),
    level: z.enum(['micro', 'full']),
    preTokens: z.number(),
    postTokens: z.number(),
  }),
  z.object({ type: z.literal('error'), message: z.string(), recoverable: z.boolean() }),
  z.object({ type: z.literal('user-question'), question: userQuestionSchema }),
  z.object({
    type: z.literal('peer-event'),
    agentId: z.enum(['B', 'C']),
    event: peerInnerEventSchema,
  }),
  z.object({
    type: z.literal('candidate-submitted'),
    agentId: z.enum(['Main', 'B', 'C']),
    candidateId: z.string(),
    summary: z.string(),
    details: candidateDetailsSchema.optional(),
  }),
  z.object({
    type: z.literal('vote-cast'),
    from: z.enum(['Main', 'B', 'C']),
    target: z.string(),
    vote: z.enum(['accept', 'accept_with_minor_edits', 'reject']),
    reason: z.string(),
    suggestedChange: z.string().optional(),
  }),
  z.object({
    type: z.literal('negotiation-started'),
    taskId: z.string(),
    mode: z.enum(['quick_review', 'full_consensus']),
  }),
  z.object({ type: z.literal('round-started'), taskId: z.string(), round: z.union([z.literal(2), z.literal(3)]) }),
  z.object({
    type: z.literal('negotiation-decided'),
    taskId: z.string(),
    selectedCandidateIds: z.array(z.string()),
    reason: z.string(),
    scores: z
      .object({ Main: z.number(), B: z.number(), C: z.number() })
      .optional(),
  }),
  z.object({ type: z.literal('execution-started'), taskId: z.string() }),
  z.object({ type: z.literal('task-plan-updated'), plan: taskPlanSchema }),
  z.object({ type: z.literal('task-plan-restored'), plan: taskPlanSchema.nullable() }),
])

export const viewEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user-message'),
    text: z.string().min(1),
    startsTurn: z.boolean(),
  }),
  z.object({ type: z.literal('core-event'), event: visibleCoreEventSchema }),
])

export type VisibleCoreEvent = z.infer<typeof visibleCoreEventSchema>
export type ViewEvent = z.infer<typeof viewEventSchema>

/** CoreEvent → 可持久化的用户可见事件；运行态、审批和已失效检查点不会进入时间线。 */
export function toViewEvent(event: CoreEvent): ViewEvent | null {
  if (event.type === 'message-injected') {
    return { type: 'user-message', text: event.text, startsTurn: false }
  }
  if (event.type === 'peer-event') {
    if (!['text-delta', 'tool-start', 'tool-end'].includes(event.event.type)) return null
    return viewEventSchema.parse({ type: 'core-event', event })
  }
  switch (event.type) {
    case 'turn-start':
    case 'text-delta':
    case 'thinking-delta':
    case 'thinking-end':
    case 'tool-start':
    case 'tool-progress':
    case 'tool-end':
    case 'checkpoint-created':
    case 'checkpoint-disabled':
    case 'checkpoint-restored':
    case 'context-compacted':
    case 'error':
    case 'user-question':
    case 'candidate-submitted':
    case 'vote-cast':
    case 'negotiation-started':
    case 'round-started':
    case 'negotiation-decided':
    case 'execution-started':
    case 'task-plan-updated':
    case 'task-plan-restored':
      return viewEventSchema.parse({ type: 'core-event', event })
    default:
      return null
  }
}

/** 合并高频流式片段，避免一个 token 对应一条内存事件。 */
export function pushCoalescedViewEvent(events: ViewEvent[], next: ViewEvent): void {
  const previous = events.at(-1)
  if (!previous || previous.type !== 'core-event' || next.type !== 'core-event') {
    events.push(next)
    return
  }
  if (previous.event.type === 'text-delta' && next.event.type === 'text-delta') {
    previous.event.text += next.event.text
    return
  }
  if (previous.event.type === 'thinking-delta' && next.event.type === 'thinking-delta') {
    previous.event.text += next.event.text
    return
  }
  if (
    previous.event.type === 'tool-progress' &&
    next.event.type === 'tool-progress' &&
    previous.event.toolUseId === next.event.toolUseId
  ) {
    previous.event.output += next.event.output
    return
  }
  if (
    previous.event.type === 'peer-event' &&
    next.event.type === 'peer-event' &&
    previous.event.agentId === next.event.agentId &&
    previous.event.event.type === 'text-delta' &&
    next.event.event.type === 'text-delta'
  ) {
    previous.event.event.text += next.event.event.text
    return
  }
  events.push(next)
}

/** 编译期保证持久化事件仍是 CoreEvent 的合法子集。 */
const _visibleEventTypeCheck: VisibleCoreEvent extends CoreEvent ? true : never = true
void _visibleEventTypeCheck
