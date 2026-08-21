import { z } from 'zod'
import {
  compactVisibleCoreEvent,
  coalesceAdjacentCoreEvent,
  MAX_USER_QUESTIONS,
  type CoreEvent,
} from '../events.ts'
import { activeTaskPlanSchema, taskPlanSchema } from '../tasks/types.ts'
import {
  toolImageAttachmentsSchema,
  userImageAttachmentsSchema,
} from '../attachments/types.ts'
import { pdfAttachmentsSchema } from '../pdf/types.ts'
import {
  SKILL_MAX_SELECTIONS_PER_MESSAGE,
  skillSummarySchema,
} from '../skills/types.ts'

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

const userQuestionItemSchema = z.object({
  header: z.string().min(1),
  question: z.string().min(1),
  options: z
    .array(z.object({
      label: z.string().min(1),
      description: z.string().min(1),
    }).strict())
    .min(2)
    .max(4),
}).strict()

const userQuestionSchema = z.object({
  id: z.string().min(1),
  questions: z.array(userQuestionItemSchema).min(1).max(MAX_USER_QUESTIONS),
}).strict()

export const visibleCoreEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn-start'), turnId: z.string() }),
  z.object({
    type: z.literal('user-message-edited'),
    previousTurnId: z.string().min(1),
    inputId: z.string().min(1),
    text: z.string().min(1),
    taskPlan: activeTaskPlanSchema.nullable(),
  }),
  z.object({
    type: z.literal('work-finished'),
    durationMs: z.number().nonnegative(),
    outcome: z.enum(['completed', 'stopped']),
    forkTurnId: z.string().min(1).nullable(),
  }),
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('thinking-delta'), text: z.string() }),
  z.object({ type: z.literal('thinking-end'), durationMs: z.number().nonnegative() }),
  toolStartSchema,
  toolProgressSchema,
  toolEndSchema,
  z.object({
    type: z.literal('image-viewed'),
    toolUseId: z.string(),
    attachments: toolImageAttachmentsSchema.min(1),
  }),
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
    question: userQuestionSchema.nullable().optional(),
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
  z.object({
    type: z.literal('consensus-skipped'),
    reason: z.enum(['image-input', 'pdf-input']),
  }),
  z.object({ type: z.literal('task-plan-updated'), plan: taskPlanSchema }),
  z.object({ type: z.literal('task-plan-restored'), plan: taskPlanSchema.nullable() }),
])

const userMessageViewEventSchema = z.object({
  type: z.literal('user-message'),
  /** steering 的稳定身份；旧会话与根消息允许省略。 */
  inputId: z.string().min(1).optional(),
  text: z.string(),
  startsTurn: z.boolean(),
  attachments: userImageAttachmentsSchema.optional(),
  pdfAttachments: pdfAttachmentsSchema.optional(),
  skills: z.array(skillSummarySchema)
    .min(1)
    .max(SKILL_MAX_SELECTIONS_PER_MESSAGE)
    .optional(),
}).superRefine((event, ctx) => {
  if (event.text.length === 0 && !event.attachments?.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['text'],
      message: '空正文用户消息必须包含图片',
    })
  }
})

export const viewEventSchema = z.discriminatedUnion('type', [
  userMessageViewEventSchema,
  z.object({ type: z.literal('core-event'), event: visibleCoreEventSchema }),
])

export type VisibleCoreEvent = z.infer<typeof visibleCoreEventSchema>
export type ViewEvent = z.infer<typeof viewEventSchema>

/** 对话卡片只承载展示摘要；完整工具结果仍由模型消息与工具日志持有。 */
export function compactViewEvent(event: ViewEvent): ViewEvent {
  if (event.type !== 'core-event') return event
  const compacted = compactVisibleCoreEvent(event.event) as VisibleCoreEvent
  return compacted === event.event ? event : { type: 'core-event', event: compacted }
}

/** CoreEvent → 可持久化的用户可见事件；运行态、审批和已失效检查点不会进入时间线。 */
export function toViewEvent(event: CoreEvent): ViewEvent | null {
  if (event.type === 'message-injected') {
    return {
      type: 'user-message',
      inputId: event.id,
      text: event.text,
      startsTurn: event.startsTurn ?? false,
      ...(event.attachments?.length ? { attachments: event.attachments } : {}),
      ...(event.pdfAttachments?.length ? { pdfAttachments: event.pdfAttachments } : {}),
      ...(event.skills?.length ? { skills: event.skills } : {}),
    }
  }
  if (event.type === 'peer-event') {
    if (!['text-delta', 'tool-start', 'tool-end'].includes(event.event.type)) return null
    return compactViewEvent(viewEventSchema.parse({ type: 'core-event', event }))
  }
  // 编辑关系已经与新根 user-input 原子落盘；重放从该事实派生，不能再写一份副本。
  if (event.type === 'user-message-edited') return null
  switch (event.type) {
    case 'turn-start':
    case 'work-finished':
    case 'text-delta':
    case 'thinking-delta':
    case 'thinking-end':
    case 'tool-start':
    case 'tool-progress':
    case 'tool-end':
    case 'image-viewed':
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
    case 'consensus-skipped':
    case 'task-plan-updated':
    case 'task-plan-restored':
      return viewEventSchema.parse(compactViewEvent({ type: 'core-event', event }))
    default:
      return null
  }
}

/** 合并高频流式片段，避免一个 token 对应一条内存事件。 */
export function pushCoalescedViewEvent(events: ViewEvent[], next: ViewEvent): void {
  next = compactViewEvent(next)
  const previous = events.at(-1)
  if (!previous || previous.type !== 'core-event' || next.type !== 'core-event') {
    events.push(next)
    return
  }
  const event = coalesceAdjacentCoreEvent(previous.event, next.event)
  if (event) {
    events[events.length - 1] = { type: 'core-event', event }
    return
  }
  events.push(next)
}

/** 编译期保证持久化事件仍是 CoreEvent 的合法子集。 */
const _visibleEventTypeCheck: VisibleCoreEvent extends CoreEvent ? true : never = true
void _visibleEventTypeCheck
