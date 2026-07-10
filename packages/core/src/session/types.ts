import { modelMessageSchema, type ModelMessage } from 'ai'
import { z } from 'zod'
import {
  consensusPersistedStateSchema,
  type ConsensusPersistedState,
  type ConsensusTaskOutcome,
} from '../consensus/types.ts'
import type { StopReason } from '../events.ts'
import { viewEventSchema, type ViewEvent } from './view-events.ts'

export const SESSION_SCHEMA_VERSION = 1

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
  stopReason: z.enum(['completed', 'aborted', 'max-turns', 'error']),
})

const consensusTaskStartSchema = chainedEntrySchema.extend({
  type: z.literal('consensus-task-start'),
  taskId: z.string().min(1),
  state: consensusPersistedStateSchema,
})

const consensusTaskEndSchema = chainedEntrySchema.extend({
  type: z.literal('consensus-task-end'),
  taskId: z.string().min(1),
  outcome: z.enum(['completed', 'max-turns', 'aborted', 'error']),
  state: consensusPersistedStateSchema,
  rollbackMessages: messagesSchema.nullable(),
})

const snapshotSchema = chainedEntrySchema.extend({
  type: z.literal('snapshot'),
  parentUuid: z.null(),
  reason: z.enum(['compact', 'rollback', 'recovery']),
  activeTurnId: z.string().min(1).nullable(),
  activeConsensusTaskId: z.string().min(1).nullable(),
  activeConsensusBaseMessages: messagesSchema.nullable(),
  consensusState: consensusPersistedStateSchema.nullable(),
  modelId: z.string().min(1),
  messages: messagesSchema,
  /** 回滚换根后仍保留新根内较早 turn 的边界；压缩快照写空数组。 */
  turnStartMessages: z.array(z.object({
    turnId: z.string().min(1),
    messages: messagesSchema,
  })).optional(),
})

export const sessionEntrySchema = z.discriminatedUnion('type', [
  sessionStartSchema,
  userInputSchema,
  modelChangeSchema,
  viewEventsEntrySchema,
  turnStartSchema,
  messagesEntrySchema,
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
  status: z.enum(['idle', 'running', 'max-turns', 'interrupted', 'error']),
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
  entries: SessionEntry[]
  leafUuid: string
  interruptedTurnId: string | null
  interruptedConsensusTaskId: string | null
  interruptedConsensusBaseMessages: ModelMessage[] | null
  consensusState: ConsensusPersistedState | null
}

export interface SessionRecorder {
  readonly sessionId: string
  readonly checkpointDirectory: string
  readonly initialMessages: readonly ModelMessage[]
  readonly initialViewEvents: readonly ViewEvent[]
  readonly interruptedTurnId: string | null
  readonly interruptedConsensusTaskId: string | null
  readonly initialConsensusState: ConsensusPersistedState | null
  /** 仅返回仍位于当前活动父链上的 turn 起点；压缩/旧回滚之前的 turn 返回 null。 */
  messagesBeforeTurn(turnId: string): ModelMessage[] | null
  recordUserInput(text: string): Promise<void>
  recordViewEvents(events: ViewEvent[]): Promise<void>
  recordTurnStart(turnId: string, messages: ModelMessage[]): Promise<void>
  recordStep(turnId: string, messages: ModelMessage[]): Promise<void>
  recordTurnEnd(turnId: string, stopReason: StopReason): Promise<void>
  recordSnapshot(
    reason: 'compact' | 'rollback',
    messages: ModelMessage[],
    activeTurnId?: string,
  ): Promise<void>
  recordConsensusTaskStart(taskId: string, state: ConsensusPersistedState): Promise<void>
  recordConsensusTaskEnd(
    taskId: string,
    outcome: ConsensusTaskOutcome,
    state: ConsensusPersistedState,
  ): Promise<void>
  updateModel(modelId: string): Promise<void>
}

export type SessionStatus = SessionMetadata['status']
