import { z } from 'zod'

export const commandTaskStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'stopped',
  'interrupted',
])

export const persistedCommandTaskSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  sessionId: z.string().min(1),
  command: z.string(),
  cwd: z.string(),
  status: commandTaskStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  exitCode: z.number().int().nullable().optional(),
  failureReason: z.string().optional(),
  outputBytes: z.number().int().nonnegative(),
  outputTruncated: z.boolean(),
})

export type CommandTaskStatus = z.infer<typeof commandTaskStatusSchema>
export type PersistedCommandTask = z.infer<typeof persistedCommandTaskSchema>

export interface CommandTaskSnapshot extends PersistedCommandTask {
  canWrite: boolean
}

export interface CommandOutputChunk {
  task: CommandTaskSnapshot
  output: string
  offset: number
  nextOffset: number
}

export interface CommandTaskTerminalNotification {
  task: CommandTaskSnapshot
  /** 任务启动时确实处于 engaged 的计划；仅供同一计划的内部续轮恢复执行权。 */
  engagedPlanId?: string
}

export interface CommandTaskNotificationHandoff {
  task: CommandTaskSnapshot
  armed: boolean
}

/** Renderer 使用的只读摘要；不携带日志、stdin 能力或计划内部状态。 */
export interface BackgroundTaskSummary {
  id: string
  sessionId: string
  kind: 'command'
  label: string
  status: CommandTaskStatus
  startedAt: string
  endedAt?: string
  detail?: string
  /** 只表示任务终态会触发所属模型会话续轮，不改变任务类型。 */
  wakeOnCompletion: boolean
}

/** 整表快照使用单调修订号，避免 Renderer 恢复与实时推送交错后回退。 */
export interface BackgroundTaskState {
  sessionId: string
  revision: number
  tasks: BackgroundTaskSummary[]
}
