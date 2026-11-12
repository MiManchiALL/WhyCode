import { z } from 'zod'
import {
  compactVisibleCoreEvent,
  coalesceAdjacentCoreEvent,
  userQuestionSchema,
  pendingQuestionSchema,
  questionReplySchema,
  type CoreEvent,
} from '../events.ts'
import { taskPlanSchema } from '../tasks/types.ts'
import {
  toolImageAttachmentsSchema,
  userImageAttachmentsSchema,
} from '../attachments/types.ts'
import { pdfAttachmentsSchema } from '../pdf/types.ts'
import {
  SKILL_MAX_SELECTIONS_PER_MESSAGE,
  skillSummarySchema,
} from '../skills/types.ts'
import { BTW_MAX_TURNS, btwModeSchema } from './btw.ts'

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

const toolFileChangeSchema = z.object({
  path: z.string(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
}).strict()

const toolEndSchema = z.object({
  type: z.literal('tool-end'),
  toolUseId: z.string(),
  result: z.unknown(),
  isError: z.boolean(),
  fileChanges: z.array(toolFileChangeSchema).optional(),
})

const textDeltaSchema = z.object({
  type: z.literal('text-delta'), text: z.string(), textBlock: z.number().int().nonnegative().optional(),
})

const peerInnerEventSchema = z.discriminatedUnion('type', [
  textDeltaSchema,
  toolStartSchema,
  toolEndSchema,
])

const candidateDetailsSchema = z.object({
  finalAnswerOrPlan: z.string(),
  evidenceRefs: z.array(z.string()).optional(),
  knownRisks: z.array(z.string()).optional(),
})

export const contextCompactedSchema = z.object({
  type: z.literal('context-compacted'),
  level: z.enum(['micro', 'full']),
  compactionId: z.string().uuid().optional(),
  preTokens: z.number().nonnegative(),
  postTokens: z.number().nonnegative(),
})

export const visibleCoreEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn-start'), turnId: z.string() }),
  z.object({
    type: z.literal('model-request-retry'),
    retry: z.number().int().positive(),
    maxRetries: z.number().int().positive(),
    delayMs: z.number().nonnegative(),
    message: z.string(),
  }),
  z.object({
    type: z.literal('user-message-edited'),
    questions: z.array(pendingQuestionSchema).optional(),
    questionReply: questionReplySchema.optional(),
    previousTurnId: z.string().min(1),
    inputId: z.string().min(1),
    text: z.string().min(1),
    taskPlan: taskPlanSchema.nullable(),
  }),
  z.object({
    type: z.literal('btw-message-edited'),
    previousInputId: z.string().min(1),
    inputId: z.string().min(1),
    text: z.string().min(1),
    btw: z.object({
      conversationId: z.string().uuid(),
      turnIndex: z.number().int().min(1).max(BTW_MAX_TURNS),
      mode: btwModeSchema,
    }).strict(),
  }),
  z.object({
    type: z.literal('work-finished'),
    durationMs: z.number().nonnegative(),
    outcome: z.enum(['completed', 'stopped', 'error']),
    error: z.string().optional(),
    forkTurnId: z.string().min(1).nullable(),
    btw: z.object({
      conversationId: z.string().uuid(),
      turnIndex: z.number().int().min(1).max(BTW_MAX_TURNS),
      continuationAvailable: z.boolean(),
    }).strict().optional(),
  }),
  textDeltaSchema,
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
    questions: z.array(pendingQuestionSchema).optional(),
  }),
  z.object({ type: z.literal('context-compaction'), compactionId: z.string().uuid(), status: z.enum(['running', 'stopped', 'failed']) }),
  contextCompactedSchema,
  z.object({ type: z.literal('error'), message: z.string(), recoverable: z.boolean() }),
  z.object({ type: z.literal('user-question'), question: userQuestionSchema }),
  z.object({ type: z.literal('user-question-resolved'), resolutions: questionReplySchema }),
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
  /** 独立侧对话身份；存在时该消息永远不属于 Main turn。 */
  btw: z.object({
    conversationId: z.string().uuid(),
    turnIndex: z.number().int().min(1).max(BTW_MAX_TURNS),
    mode: btwModeSchema,
  }).strict().optional(),
}).superRefine((event, ctx) => {
  if (event.text.length === 0 && !event.attachments?.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['text'],
      message: '空正文用户消息必须包含图片',
    })
  }
  if (event.btw && event.startsTurn) {
    ctx.addIssue({ code: 'custom', path: ['startsTurn'], message: 'BTW 不建立 Main turn' })
  }
})

export const viewEventSchema = z.discriminatedUnion('type', [
  userMessageViewEventSchema,
  z.object({ type: z.literal('core-event'), event: visibleCoreEventSchema }),
])

export type VisibleCoreEvent = z.infer<typeof visibleCoreEventSchema>
export type RecordedViewEvent = z.infer<typeof viewEventSchema>
/** 步骤边界和回合完成从现有 JSONL 记录投影，不写入可见事件批次。 */
export type ViewEvent = RecordedViewEvent
  | { type: 'step-committed'; hasToolCalls: boolean }
  | { type: 'turn-completed' }
  | { type: 'pending-questions'; questions: import('../user-questions.ts').PendingQuestion[] }

/** 普通插话属于根回合；后续根消息和独立 BTW 输入才会取代编辑目标。 */
export function latestVisibleRootTurn(events: readonly ViewEvent[], turnId: string) {
  const index = events.findLastIndex(entry => entry.type === 'user-message' && (entry.startsTurn || entry.btw))
  const root = events[index]
  const afterRoot = events.slice(index + 1)
  const first = afterRoot.find(entry => entry.type === 'core-event' && entry.event.type === 'turn-start')
  if (root?.type !== 'user-message' || !root.startsTurn || first?.type !== 'core-event'
    || first.event.type !== 'turn-start' || first.event.turnId !== turnId) {
    throw new Error('只能编辑最新一条用户消息')
  }
  return { root, afterRoot }
}

/** 对话卡片只承载展示摘要；完整工具结果仍由模型消息与工具日志持有。 */
export function compactViewEvent(event: RecordedViewEvent): RecordedViewEvent {
  if (event.type !== 'core-event') return event
  const compacted = compactVisibleCoreEvent(event.event) as VisibleCoreEvent
  return compacted === event.event ? event : { type: 'core-event', event: compacted }
}

/** 派生单独写入时间线的事件。压缩成功已随快照提交，由 responseViewEvents 展开。 */
export function toViewEvent(event: CoreEvent): RecordedViewEvent | null {
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
  if (event.type === 'user-message-edited' || event.type === 'btw-message-edited') return null
  // 失败回滚没有改变可恢复状态，只作为当前窗口的即时操作反馈，不污染会话时间线。
  if (event.type === 'checkpoint-restored' && !event.ok) return null
  switch (event.type) {
    case 'turn-start':
    case 'work-finished':
    case 'model-request-retry':
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
    case 'context-compaction':
    case 'error':
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
export function pushCoalescedViewEvent(events: RecordedViewEvent[], next: RecordedViewEvent): void {
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
