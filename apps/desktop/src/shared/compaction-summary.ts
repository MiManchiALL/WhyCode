import { z } from 'zod'
import type { SessionCompactionSummary } from '@whycode/core'

export const compactionSummaryRequestSchema = z.object({
  runtimeId: z.string().uuid(),
  index: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()

export type CompactionSummaryRequest = z.infer<typeof compactionSummaryRequestSchema>
export type CompactionSummaryResult =
  | { ok: true; summary: SessionCompactionSummary }
  | { ok: false; error: string }
