import { modelMessageSchema, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  consensusPersistedStateSchema,
  type ConsensusPersistedState,
  type ConsensusTaskOutcome,
} from '../consensus/types.ts'
import type { StopReason } from '../events.ts'
import {
  taskPlanStateSchema,
  type TaskPlanState,
  type TaskPlanStepUpdate,
} from '../tasks/types.ts'
import { viewEventSchema, type ViewEvent } from './view-events.ts'
import {
  createImageAttachmentsSchema,
  imageAttachmentsSchema,
  type ImageAttachment,
} from '../attachments/types.ts'
import {
  PDF_VISUAL_MAX_PAGES,
  pdfAttachmentsSchema,
  type PdfAttachment,
} from '../pdf/types.ts'
import {
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortSelection,
} from '../providers/catalog.ts'
import type { ProjectInstructionsUpdate } from '../instructions/project.ts'

export const SESSION_SCHEMA_VERSION = 4

const sessionIdSchema = z.string().uuid()
const entryIdSchema = z.string().uuid()
const timestampSchema = z.string().datetime()
const messagesSchema = z.array(modelMessageSchema)
const reasoningEffortSelectionSchema = z.enum(['default', ...REASONING_EFFORT_LEVELS])
/** 工具步骤可持久化一批 PDF 页面图；用户输入仍严格使用四图 schema。 */
const toolImageAttachmentsSchema = createImageAttachmentsSchema(PDF_VISUAL_MAX_PAGES)

const pendingUserInputSchema = z.object({
  id: entryIdSchema,
  text: z.string().min(1),
  attachments: imageAttachmentsSchema.optional(),
  pdfAttachments: pdfAttachmentsSchema.optional(),
  state: z.enum(['queued', 'restored']),
})

const chainedEntrySchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  uuid: entryIdSchema,
  parentUuid: entryIdSchema.nullable(),
  timestamp: timestampSchema,
})

const sessionStartSchema = chainedEntrySchema.extend({
  type: z.literal('session-start'),
  parentUuid: z.null(),
  projectDir: z.string().nullable(),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSelectionSchema.optional(),
})

const turnStartSchema = chainedEntrySchema.extend({
  type: z.literal('turn-start'),
  turnId: z.string().min(1),
  engagedPlanId: z.string().uuid().nullable(),
})

const userInputSchema = chainedEntrySchema.extend({
  type: z.literal('user-input'),
  text: z.string().min(1),
  /** true 时该输入同时是可见时间线中的新回合消息。 */
  startsTurn: z.boolean(),
  /** 图片字节位于会话 attachments/；这里只保存可恢复的元数据。 */
  attachments: imageAttachmentsSchema.optional(),
  /** PDF 原文件位于会话 attachments/；这里只保存稳定引用元数据。 */
  pdfAttachments: pdfAttachmentsSchema.optional(),
  /** 重新提交恢复草稿时，与新输入在同一次 append 中原子消费旧输入。 */
  consumesInputIds: z.array(entryIdSchema).min(1).optional(),
}).superRefine((input, ctx) => {
  input.attachments?.forEach((attachment, index) => {
    if (attachment.sessionId !== input.sessionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['attachments', index, 'sessionId'],
        message: '附件必须属于当前会话',
      })
    }
  })
  input.pdfAttachments?.forEach((attachment, index) => {
    if (attachment.sessionId !== input.sessionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['pdfAttachments', index, 'sessionId'],
        message: 'PDF 附件必须属于当前会话',
      })
    }
  })
})

const userInputRestoredSchema = chainedEntrySchema.extend({
  type: z.literal('user-input-restored'),
  inputIds: z.array(entryIdSchema).min(1),
})

const modelChangeSchema = chainedEntrySchema.extend({
  type: z.literal('model-change'),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSelectionSchema.optional(),
})

const projectInstructionsSchema = chainedEntrySchema.extend({
  type: z.literal('project-instructions'),
  version: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  message: modelMessageSchema.nullable(),
})

const viewEventsEntrySchema = chainedEntrySchema.extend({
  type: z.literal('view-events'),
  events: z.array(viewEventSchema).min(1),
})

const messagesEntrySchema = chainedEntrySchema.extend({
  type: z.literal('messages'),
  turnId: z.string().min(1),
  messages: messagesSchema,
  /** 本 step 由图片工具导入的会话附件；图片字节仍只位于 attachments/。 */
  attachments: toolImageAttachmentsSchema.optional(),
  /** 本 step 由工具导入的 PDF；原文件仍只位于 attachments/。 */
  pdfAttachments: pdfAttachmentsSchema.optional(),
  /** 与本批消息同一崩溃原子提交的权威任务状态；省略表示未变化。 */
  taskState: taskPlanStateSchema.optional(),
  /** 本批稳定提交后的 execution run：省略表示不变，null 表示解除接合。 */
  engagedPlanId: z.string().uuid().nullable().optional(),
  /** 与本批模型消息同一原子记录确认送达的忙时输入。 */
  deliveredInputIds: z.array(entryIdSchema).min(1).optional(),
}).superRefine((entry, ctx) => {
  entry.attachments?.forEach((attachment, index) => {
    if (attachment.sessionId !== entry.sessionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['attachments', index, 'sessionId'],
        message: '附件必须属于当前会话',
      })
    }
  })
  entry.pdfAttachments?.forEach((attachment, index) => {
    if (attachment.sessionId !== entry.sessionId) {
      ctx.addIssue({
        code: 'custom',
        path: ['pdfAttachments', index, 'sessionId'],
        message: 'PDF 附件必须属于当前会话',
      })
    }
  })
})

const turnEndSchema = chainedEntrySchema.extend({
  type: z.literal('turn-end'),
  turnId: z.string().min(1),
  stopReason: z.enum(['completed', 'waiting-user', 'paused', 'aborted', 'max-turns', 'error']),
})

const consensusTaskStartSchema = chainedEntrySchema.extend({
  type: z.literal('consensus-task-start'),
  taskId: z.string().min(1),
  state: consensusPersistedStateSchema,
  baseTaskState: taskPlanStateSchema,
  /** 共识失败/取消后仍需保留的原始请求；随中断标记一起恢复。 */
  userText: z.string().min(1),
  /** 共识任务开始前仍有效的对话回滚锚点；任务内锚点在回滚时必须丢弃。 */
  baseTurnIds: z.array(z.string().min(1)),
  /** 作为本次协商根请求被消费的持久输入。 */
  deliveredInputIds: z.array(entryIdSchema).min(1).optional(),
})

const consensusTaskEndSchema = chainedEntrySchema.extend({
  type: z.literal('consensus-task-end'),
  taskId: z.string().min(1),
  outcome: z.enum(['completed', 'paused', 'max-turns', 'aborted', 'error']),
  state: consensusPersistedStateSchema,
  rollbackMessages: messagesSchema.nullable(),
  /** 本条记录生效后的活动计划；取消/异常时等于任务起点状态。 */
  taskState: taskPlanStateSchema,
})

const snapshotSchema = chainedEntrySchema.extend({
  type: z.literal('snapshot'),
  parentUuid: z.null(),
  reason: z.enum(['compact', 'rollback', 'recovery']),
  activeTurnId: z.string().min(1).nullable(),
  activeTurnEngagedPlanId: z.string().uuid().nullable(),
  activeConsensusTaskId: z.string().min(1).nullable(),
  activeConsensusBaseMessages: messagesSchema.nullable(),
  activeConsensusBaseTaskState: taskPlanStateSchema.nullable(),
  activeConsensusBaseTurnIds: z.array(z.string().min(1)).nullable(),
  consensusState: consensusPersistedStateSchema.nullable(),
  taskState: taskPlanStateSchema,
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSelectionSchema.optional(),
  messages: messagesSchema,
  /**
   * 换根时携带忙时输入。早期 v4 根本没有持久队列，字段缺失只可能表示空队列，
   * 因而这里的 default 是确定性兼容，不用于吞掉结构损坏或做部分恢复。
   */
  pendingUserInputs: z.array(pendingUserInputSchema).default([]),
  /** 回滚换根后仍保留新根内较早 turn 的边界；压缩快照写空数组。 */
  turnStartMessages: z.array(z.object({
    turnId: z.string().min(1),
    messages: messagesSchema,
    taskState: taskPlanStateSchema,
  })),
}).superRefine((snapshot, ctx) => {
  if (snapshot.activeTurnEngagedPlanId && !snapshot.activeTurnId) {
    ctx.addIssue({ code: 'custom', message: '没有 activeTurnId 时不能保留 engaged plan' })
  }
  if (
    snapshot.activeTurnEngagedPlanId
    && snapshot.activeTurnEngagedPlanId !== snapshot.taskState.activePlan?.id
  ) {
    ctx.addIssue({ code: 'custom', message: 'engaged plan 必须匹配 snapshot 的 active plan' })
  }
  snapshot.pendingUserInputs.forEach((input, inputIndex) => {
    input.attachments?.forEach((attachment, attachmentIndex) => {
      if (attachment.sessionId !== snapshot.sessionId) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingUserInputs', inputIndex, 'attachments', attachmentIndex, 'sessionId'],
          message: '附件必须属于当前会话',
        })
      }
    })
    input.pdfAttachments?.forEach((attachment, attachmentIndex) => {
      if (attachment.sessionId !== snapshot.sessionId) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingUserInputs', inputIndex, 'pdfAttachments', attachmentIndex, 'sessionId'],
          message: 'PDF 附件必须属于当前会话',
        })
      }
    })
  })
})

export const sessionEntrySchema = z.discriminatedUnion('type', [
  sessionStartSchema,
  userInputSchema,
  userInputRestoredSchema,
  modelChangeSchema,
  projectInstructionsSchema,
  viewEventsEntrySchema,
  turnStartSchema,
  messagesEntrySchema,
  turnEndSchema,
  consensusTaskStartSchema,
  consensusTaskEndSchema,
  snapshotSchema,
])

export type SessionEntry = z.infer<typeof sessionEntrySchema>
export type PendingUserInput = z.infer<typeof pendingUserInputSchema>

export const sessionMetadataSchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  projectDir: z.string().nullable(),
  modelId: z.string().min(1),
  reasoningEffort: reasoningEffortSelectionSchema,
  title: z.string(),
  lastUserText: z.string(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  status: z.enum([
    'idle',
    'running',
    'waiting-user',
    'paused',
    'max-turns',
    'interrupted',
    'error',
  ]),
})

export type SessionMetadata = z.infer<typeof sessionMetadataSchema>

interface SessionSummaryBase {
  sessionId: string
  title: string
  lastUserText: string
  createdAt: string
  updatedAt: string
}

/**
 * 会话列表的只读摘要。列表可见性不等于可恢复性：旧版本或损坏的合法会话目录
 * 仍必须暴露给宿主，以便用户删除，而不能成为磁盘上的隐形残留。
 */
export type SessionSummary =
  | SessionSummaryBase & {
      resumable: true
      projectDir: string | null
      modelId: string
      reasoningEffort: ReasoningEffortSelection
      status: SessionStatus
      unavailableReason?: never
    }
  | SessionSummaryBase & {
      resumable: false
      /** 旧 metadata 无法可信读取时保持 unknown，不能误标成纯聊天。 */
      projectDir?: string | null
      modelId: string | null
      status: 'unavailable'
      unavailableReason: string
    }

export interface SessionCreateInput {
  projectDir: string | null
  modelId: string
  reasoningEffort?: ReasoningEffortSelection
}

export interface LoadedSession {
  metadata: SessionMetadata
  messages: ModelMessage[]
  viewEvents: ViewEvent[]
  /** 用户输入与图片工具在该会话中持久化的全部附件元数据。 */
  imageAttachments: ImageAttachment[]
  /** 用户输入与工具在该会话中持久化的全部 PDF 元数据。 */
  pdfAttachments: PdfAttachment[]
  turnStartMessages: Map<string, ModelMessage[]>
  turnStartTaskStates: Map<string, TaskPlanState>
  entries: SessionEntry[]
  leafUuid: string
  interruptedTurnId: string | null
  interruptedTurnEngagedPlanId: string | null
  /** 已展示但尚未进入完整 turn/messages 或共识起点的根用户输入。 */
  undeliveredUserInputIds: string[]
  /** 尚未送达的 steering；restored 状态由 Renderer 持有为可恢复草稿。 */
  pendingUserInputs: PendingUserInput[]
  interruptedConsensusTaskId: string | null
  interruptedConsensusBaseMessages: ModelMessage[] | null
  interruptedConsensusBaseTaskState: TaskPlanState | null
  interruptedConsensusBaseTurnIds: string[] | null
  consensusState: ConsensusPersistedState | null
  taskState: TaskPlanState
}

export interface SessionRecorder {
  readonly sessionId: string
  readonly checkpointDirectory: string
  readonly attachmentDirectory: string
  readonly initialMessages: readonly ModelMessage[]
  readonly initialViewEvents: readonly ViewEvent[]
  readonly initialImageAttachments: readonly ImageAttachment[]
  readonly initialPdfAttachments: readonly PdfAttachment[]
  readonly interruptedTurnId: string | null
  readonly undeliveredUserInputIds: readonly string[]
  readonly pendingUserInputs: readonly PendingUserInput[]
  readonly interruptedConsensusTaskId: string | null
  readonly initialConsensusState: ConsensusPersistedState | null
  readonly initialTaskState: TaskPlanState
  /** 仅返回仍位于当前活动父链上的 turn 起点；压缩/旧回滚之前的 turn 返回 null。 */
  messagesBeforeTurn(turnId: string): ModelMessage[] | null
  /** undefined = turn 已不在活动父链；null = turn 起点没有活动计划。 */
  taskStateBeforeTurn(turnId: string): TaskPlanState | undefined
  recordUserInput(
    text: string,
    startsTurn: boolean,
    attachments?: readonly ImageAttachment[],
    pdfAttachments?: readonly PdfAttachment[],
  ): Promise<void>
  /** Main 预先分配 ID，使落盘记录与运行时 steering 使用同一身份。 */
  recordUserInputWithId(
    inputId: string,
    text: string,
    startsTurn: boolean,
    attachments?: readonly ImageAttachment[],
    consumesInputIds?: readonly string[],
    pdfAttachments?: readonly PdfAttachment[],
  ): Promise<void>
  recordViewEvents(events: ViewEvent[]): Promise<void>
  recordTurnStart(
    turnId: string,
    messages: ModelMessage[],
    engagedPlanId?: string,
    deliveredInputIds?: readonly string[],
    projectInstructions?: ProjectInstructionsUpdate,
  ): Promise<void>
  recordProjectInstructions(update: ProjectInstructionsUpdate): Promise<void>
  recordStep(
    turnId: string,
    messages: ModelMessage[],
    taskState?: TaskPlanStepUpdate,
    engagedPlanId?: string | null,
    resources?: {
      attachments?: readonly ImageAttachment[]
      pdfAttachments?: readonly PdfAttachment[]
      deliveredInputIds?: readonly string[]
    },
  ): Promise<void>
  recordTurnEnd(turnId: string, stopReason: StopReason): Promise<void>
  recordSnapshot(
    reason: 'compact' | 'rollback',
    messages: ModelMessage[],
    activeTurnId?: string,
    taskState?: TaskPlanState,
  ): Promise<void>
  recordConsensusTaskStart(
    taskId: string,
    state: ConsensusPersistedState,
    userText: string,
    deliveredInputIds?: readonly string[],
  ): Promise<void>
  markUserInputsRestored(inputIds: readonly string[]): Promise<void>
  recordConsensusTaskEnd(
    taskId: string,
    outcome: ConsensusTaskOutcome,
    state: ConsensusPersistedState,
  ): Promise<void>
  updateModelSelection(
    modelId: string,
    reasoningEffort: ReasoningEffortSelection,
  ): Promise<void>
}

export type SessionStatus = SessionMetadata['status']
