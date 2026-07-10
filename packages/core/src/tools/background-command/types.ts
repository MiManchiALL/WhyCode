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
