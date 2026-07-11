import { modelMessageSchema, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  consensusPersistedStateSchema,
  type ConsensusPersistedState,
  type ConsensusTaskOutcome,
} from '../consensus/types.ts'
import type { StopReason } from '../events.ts'
import {
  activeTaskPlanSchema,
  type ActiveTaskPlan,
  type TaskPlanStepUpdate,
} from '../tasks/types.ts'
import { viewEventSchema, type ViewEvent } from './view-events.ts'

export const SESSION_SCHEMA_VERSION = 3

const sessionIdSchema = z.string().uuid()
const entryIdSchema = z.string().uuid()
const timestampSchema = z.string().datetime()
const messagesSchema = z.array(modelMessageSchema)

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
})

const turnStartSchema = chainedEntrySchema.extend({
  type: z.literal('turn-start'),
  turnId: z.string().min(1),
})

const userInputSchema = chainedEntrySchema.extend({
  type: z.literal('user-input'),
  text: z.string().min(1),
  /** true 时该输入同时是可见时间线中的新回合消息。 */
  startsTurn: z.boolean(),
})

const modelChangeSchema = chainedEntrySchema.extend({
  type: z.literal('model-change'),
  modelId: z.string().min(1),
})

const viewEventsEntrySchema = chainedEntrySchema.extend({
  type: z.literal('view-events'),
  events: z.array(viewEventSchema).min(1),
})

const messagesEntrySchema = chainedEntrySchema.extend({
  type: z.literal('messages'),
  turnId: z.string().min(1),
  messages: messagesSchema,
})

const turnEndSchema = chainedEntrySchema.extend({
  type: z.literal('turn-end'),
  turnId: z.string().min(1),
  stopReason: z.enum(['completed', 'waiting-user', 'paused', 'aborted', 'max-turns', 'error']),
})

const taskStateSchema = chainedEntrySchema.extend({
  type: z.literal('task-state'),
  activePlan: activeTaskPlanSchema.nullable(),
})

const consensusTaskStartSchema = chainedEntrySchema.extend({
  type: z.literal('consensus-task-start'),
  taskId: z.string().min(1),
  state: consensusPersistedStateSchema,
  baseTaskPlan: activeTaskPlanSchema.nullable(),
  /** 共识失败/取消后仍需保留的原始请求；随中断标记一起恢复。 */
  userText: z.string().min(1),
  /** 共识任务开始前仍有效的对话回滚锚点；任务内锚点在回滚时必须丢弃。 */
  baseTurnIds: z.array(z.string().min(1)),
})

const consensusTaskEndSchema = chainedEntrySchema.extend({
  type: z.literal('consensus-task-end'),
  taskId: z.string().min(1),
  outcome: z.enum(['completed', 'paused', 'max-turns', 'aborted', 'error']),
  state: consensusPersistedStateSchema,
  rollbackMessages: messagesSchema.nullable(),
  /** 本条记录生效后的活动计划；取消/异常时等于任务起点状态。 */
  taskPlan: activeTaskPlanSchema.nullable(),
})

const snapshotSchema = chainedEntrySchema.extend({
  type: z.literal('snapshot'),
  parentUuid: z.null(),
  reason: z.enum(['compact', 'rollback', 'recovery']),
  activeTurnId: z.string().min(1).nullable(),
  activeConsensusTaskId: z.string().min(1).nullable(),
  activeConsensusBaseMessages: messagesSchema.nullable(),
  activeConsensusBaseTaskPlan: activeTaskPlanSchema.nullable(),
  activeConsensusBaseTurnIds: z.array(z.string().min(1)).nullable(),
  consensusState: consensusPersistedStateSchema.nullable(),
  taskPlan: activeTaskPlanSchema.nullable(),
  modelId: z.string().min(1),
  messages: messagesSchema,
  /** 回滚换根后仍保留新根内较早 turn 的边界；压缩快照写空数组。 */
  turnStartMessages: z.array(z.object({
    turnId: z.string().min(1),
    messages: messagesSchema,
    taskPlan: activeTaskPlanSchema.nullable(),
  })),
})

export const sessionEntrySchema = z.discriminatedUnion('type', [
  sessionStartSchema,
  userInputSchema,
  modelChangeSchema,
  viewEventsEntrySchema,
  turnStartSchema,
  messagesEntrySchema,
  taskStateSchema,
  turnEndSchema,
  consensusTaskStartSchema,
  consensusTaskEndSchema,
  snapshotSchema,
])

export type SessionEntry = z.infer<typeof sessionEntrySchema>

export const sessionMetadataSchema = z.object({
  schemaVersion: z.literal(SESSION_SCHEMA_VERSION),
  sessionId: sessionIdSchema,
  projectDir: z.string().nullable(),
  modelId: z.string().min(1),
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

export interface SessionCreateInput {
  projectDir: string | null
  modelId: string
}

export interface LoadedSession {
  metadata: SessionMetadata
  messages: ModelMessage[]
  viewEvents: ViewEvent[]
  turnStartMessages: Map<string, ModelMessage[]>
  turnStartTaskPlans: Map<string, ActiveTaskPlan | null>
  entries: SessionEntry[]
  leafUuid: string
  interruptedTurnId: string | null
  /** 已展示但尚未进入完整 turn/messages 或共识起点的根用户输入。 */
  undeliveredUserInputIds: string[]
  interruptedConsensusTaskId: string | null
  interruptedConsensusBaseMessages: ModelMessage[] | null
  interruptedConsensusBaseTaskPlan: ActiveTaskPlan | null
  interruptedConsensusBaseTurnIds: string[] | null
  consensusState: ConsensusPersistedState | null
  activeTaskPlan: ActiveTaskPlan | null
}

export interface SessionRecorder {
  readonly sessionId: string
  readonly checkpointDirectory: string
  readonly initialMessages: readonly ModelMessage[]
  readonly initialViewEvents: readonly ViewEvent[]
  readonly interruptedTurnId: string | null
  readonly undeliveredUserInputIds: readonly string[]
  readonly interruptedConsensusTaskId: string | null
  readonly initialConsensusState: ConsensusPersistedState | null
  readonly initialTaskPlan: ActiveTaskPlan | null
  /** 仅返回仍位于当前活动父链上的 turn 起点；压缩/旧回滚之前的 turn 返回 null。 */
  messagesBeforeTurn(turnId: string): ModelMessage[] | null
  /** undefined = turn 已不在活动父链；null = turn 起点没有活动计划。 */
  taskPlanBeforeTurn(turnId: string): ActiveTaskPlan | null | undefined
  recordUserInput(text: string, startsTurn: boolean): Promise<void>
  recordViewEvents(events: ViewEvent[]): Promise<void>
  recordTurnStart(turnId: string, messages: ModelMessage[]): Promise<void>
  recordStep(
    turnId: string,
    messages: ModelMessage[],
    taskPlan?: TaskPlanStepUpdate,
  ): Promise<void>
  recordTurnEnd(turnId: string, stopReason: StopReason): Promise<void>
  recordSnapshot(
    reason: 'compact' | 'rollback',
    messages: ModelMessage[],
    activeTurnId?: string,
    taskPlan?: ActiveTaskPlan | null,
  ): Promise<void>
  recordConsensusTaskStart(
    taskId: string,
    state: ConsensusPersistedState,
    userText: string,
  ): Promise<void>
  recordConsensusTaskEnd(
    taskId: string,
    outcome: ConsensusTaskOutcome,
    state: ConsensusPersistedState,
  ): Promise<void>
  updateModel(modelId: string): Promise<void>
}

export type SessionStatus = SessionMetadata['status']
