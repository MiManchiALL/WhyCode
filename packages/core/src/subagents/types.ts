import { z } from 'zod'
import type { CoreEvent } from '../events.ts'
import type { PermissionMode } from '../permissions/types.ts'
import {
  REASONING_EFFORT_LEVELS,
  type ReasoningEffortSelection,
} from '../providers/catalog.ts'
import type { ViewEvent } from '../session/view-events.ts'

export const SUBAGENT_SCHEMA_VERSION = 2
export const MAX_CONCURRENT_SUBAGENTS_PER_PARENT = 8
export const MAX_SUBAGENT_DESCRIPTION_CHARS = 120
export const MAX_SUBAGENT_PROMPT_CHARS = 64_000
export const MAX_SUBAGENT_PROMPT_PREVIEW_CHARS = 2_000

export const subagentProfileSchema = z.enum(['explore', 'reviewer', 'general'])
export const subagentDefinitionScopeSchema = z.enum(['builtin', 'user', 'project'])
export const subagentOutcomeSchema = z.enum([
  'completed',
  'error',
  'aborted',
  'limit',
  'refusal',
])
export const subagentStatusSchema = z.enum([
  'running',
  'completed',
  'error',
  'aborted',
  'limit',
  'refusal',
])
export const subagentSettlementStateSchema = z.enum(['pending', 'delivered'])

const idSchema = z.string().uuid()
const timestampSchema = z.string().datetime()
const toolNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]*$/)
export const subagentTaskDescriptionSchema = z.string()
  .trim()
  .min(1)
  .max(MAX_SUBAGENT_DESCRIPTION_CHARS)

export const subagentTurnActivationSchema = z.object({
  subagentId: idSchema,
  activationId: idSchema,
  name: z.string().min(1).max(64),
  description: subagentTaskDescriptionSchema,
  sequence: z.number().int().positive(),
  outcome: subagentOutcomeSchema.optional(),
  settlement: subagentSettlementStateSchema.optional(),
}).strict().superRefine((activation, ctx) => {
  if ((activation.outcome === undefined) !== (activation.settlement === undefined)) {
    ctx.addIssue({ code: 'custom', message: '子代理 turn 激活的终态与交接状态必须同时存在' })
  }
})
export const subagentTurnStateSchema = z.object({
  parentTurnId: z.string().min(1),
  activations: z.array(subagentTurnActivationSchema),
}).strict()

export const subagentDefinitionSnapshotSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1_024),
  profile: subagentProfileSchema,
  scope: subagentDefinitionScopeSchema,
  instructions: z.string().max(64 * 1_024),
  toolNames: z.array(toolNameSchema).max(32),
  sourcePath: z.string().min(1).optional(),
}).strict()

export const subagentActivationSchema = z.object({
  id: idSchema,
  sequence: z.number().int().positive(),
  parentTurnId: z.string().min(1),
  parentToolCallId: z.string().min(1),
  promptPreview: z.string().min(1).max(MAX_SUBAGENT_PROMPT_PREVIEW_CHARS),
  engagedPlanId: idSchema.optional(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  outcome: subagentOutcomeSchema.optional(),
  resultText: z.string().optional(),
  settlement: subagentSettlementStateSchema.optional(),
}).superRefine((activation, ctx) => {
  const terminalFields = [activation.endedAt, activation.outcome, activation.resultText]
  const terminalCount = terminalFields.filter((value) => value !== undefined).length
  if (terminalCount !== 0 && terminalCount !== terminalFields.length) {
    ctx.addIssue({ code: 'custom', message: '子代理激活终态字段必须同时存在' })
  }
  if (terminalCount === 0 && activation.settlement !== undefined) {
    ctx.addIssue({ code: 'custom', message: '运行中的子代理激活不能有 settlement 状态' })
  }
  if (terminalCount > 0 && activation.settlement === undefined) {
    ctx.addIssue({ code: 'custom', message: '子代理激活终态必须记录 settlement 状态' })
  }
})

export const subagentManifestSchema = z.object({
  schemaVersion: z.literal(SUBAGENT_SCHEMA_VERSION),
  id: idSchema,
  parentSessionId: idSchema,
  createdByTurnId: z.string().min(1),
  createdByToolCallId: z.string().min(1),
  taskDescription: subagentTaskDescriptionSchema,
  definition: subagentDefinitionSnapshotSchema,
  modelId: z.string().min(1),
  reasoningEffort: z.enum(['default', ...REASONING_EFFORT_LEVELS]),
  permission: z.object({
    mode: z.enum(['readonly', 'default', 'acceptEdits', 'auto']),
    additionalDirs: z.array(z.string().min(1)),
    sessionAllowedTools: z.array(toolNameSchema),
  }).strict(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  activations: z.array(subagentActivationSchema).min(1),
}).strict()

export type SubagentProfile = z.infer<typeof subagentProfileSchema>
export type SubagentDefinitionScope = z.infer<typeof subagentDefinitionScopeSchema>
export type SubagentOutcome = z.infer<typeof subagentOutcomeSchema>
export type SubagentStatus = z.infer<typeof subagentStatusSchema>
export type SubagentDefinitionSnapshot = z.infer<typeof subagentDefinitionSnapshotSchema>
export type SubagentActivation = z.infer<typeof subagentActivationSchema>
export type SubagentManifest = z.infer<typeof subagentManifestSchema>
export type SubagentTurnActivation = z.infer<typeof subagentTurnActivationSchema>
export type SubagentTurnState = z.infer<typeof subagentTurnStateSchema>

export interface SubagentDefinitionDiagnostic {
  path: string
  message: string
}

export interface SubagentDefinitionCatalogSnapshot {
  definitions: SubagentDefinitionSnapshot[]
  diagnostics: SubagentDefinitionDiagnostic[]
  modelContext: string
}

/** 父会话和 Renderer 共享的有界摘要；完整 prompt、结果和事件只在子会话目录中。 */
export interface SubagentSummary {
  id: string
  parentSessionId: string
  name: string
  description: string
  profile: SubagentProfile
  status: SubagentStatus
  activationCount: number
  /** 已结束 activation 的累计时长；当前运行轮次由 startedAt 实时补入。 */
  completedDurationMs: number
  createdAt: string
  updatedAt: string
  startedAt: string
  endedAt?: string
}

export interface SubagentState {
  parentSessionId: string
  revision: number
  subagents: SubagentSummary[]
}

export interface SubagentTranscriptSnapshot {
  subagent: SubagentSummary
  viewEvents: ViewEvent[]
  viewEventTimestamps: string[]
  eventSequence: number
}

export interface SubagentEventEnvelope {
  parentSessionId: string
  subagentId: string
  sequence: number
  occurredAt: string
  event: CoreEvent
}

export interface SubagentPermissionSnapshot {
  mode: PermissionMode
  additionalDirs: string[]
  sessionAllowedTools: string[]
}

export interface SubagentLaunchRequest {
  definition: SubagentDefinitionSnapshot
  taskDescription: string
  prompt: string
  parentTurnId: string
  parentToolCallId: string
  engagedPlanId?: string
}

export interface SubagentContinueRequest {
  subagentId: string
  prompt: string
  parentTurnId: string
  parentToolCallId: string
  engagedPlanId?: string
}

export interface SubagentLaunchResult {
  ok: boolean
  subagentId?: string
  name?: string
  description?: string
  error?: string
}

/** 提供给父模型的最小发现投影；不暴露 prompt、结果或 transcript。 */
export interface SubagentListEntry {
  subagentId: string
  agentId: string
  description: string
  status: SubagentStatus
}

export interface SubagentSettlementNotification {
  parentSessionId: string
  parentTurnId: string
  subagentId: string
  activationId: string
  name: string
  description: string
  outcome: SubagentOutcome
  resultText: string
  engagedPlanId?: string
}

export interface SubagentModelSnapshot {
  modelId: string
  reasoningEffort: ReasoningEffortSelection
}
