import { z } from 'zod'

export const CHECKPOINT_MANIFEST_VERSION = 1

export const checkpointCoverageSchema = z.enum(['complete', 'partial', 'none'])
export type CheckpointCoverage = z.infer<typeof checkpointCoverageSchema>

export const fileStateSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(['missing', 'file']),
  contentHash: z.string().optional(),
  blobHash: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  mode: z.number().int().nonnegative().optional(),
  /** 恢复为“不存在”时，只清理本次操作前尚不存在且恢复后仍为空的父目录。 */
  missingParents: z.array(z.string()),
})

export type FileState = z.infer<typeof fileStateSchema>

const exactFileResourceSchema = z.object({
  kind: z.literal('exact-file'),
  path: z.string().min(1),
  before: fileStateSchema,
  after: fileStateSchema.optional(),
})

const treeResourceSchema = z.object({
  kind: z.literal('tree'),
  root: z.string().min(1),
  beforeHash: z.string().min(1),
  afterHash: z.string().min(1).optional(),
  changedPaths: z.array(z.string()).optional(),
})

export const checkpointResourceSchema = z.discriminatedUnion('kind', [
  exactFileResourceSchema,
  treeResourceSchema,
])

export type CheckpointResource = z.infer<typeof checkpointResourceSchema>

export const checkpointManifestSchema = z.object({
  version: z.literal(CHECKPOINT_MANIFEST_VERSION),
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  toolUseId: z.string().min(1),
  turnId: z.string().min(1),
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
  coverage: checkpointCoverageSchema,
  warnings: z.array(z.string()),
  status: z.enum(['pending', 'ready', 'invalidated']),
  resources: z.array(checkpointResourceSchema),
})

export type CheckpointManifest = z.infer<typeof checkpointManifestSchema>

export interface PreparedCheckpoint {
  id: string
}

export interface ReadyCheckpoint {
  id: string
  toolUseId: string
  turnId: string
  coverage: Exclude<CheckpointCoverage, 'none'>
  warning?: string
}
