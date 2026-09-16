import { z } from 'zod'
import type { ToolFileChange } from '../tools/file-changes.ts'

export const CHECKPOINT_MANIFEST_VERSION = 1

export const checkpointCoverageSchema = z.enum(['complete', 'partial', 'none'])

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

export const CHECKPOINT_FILE_PREVIEW_MAX_BYTES = 512 * 1_024

export type CheckpointFilePreviewState =
  | { kind: 'missing' }
  | { kind: 'text'; content: string; size: number }
  | { kind: 'unavailable'; reason: 'binary' | 'too-large'; size: number }

export interface CheckpointFilePreview {
  path: string
  before: CheckpointFilePreviewState
  after: CheckpointFilePreviewState
}

export type CheckpointFileChangesResult =
  | { ok: true; changes: ToolFileChange[] }
  | { ok: false; error: string }

export type CheckpointFilePreviewResult =
  | { ok: true; preview: CheckpointFilePreview }
  | { ok: false; error: string }

export type CheckpointFileCurrentMatchResult =
  | { ok: true; matches: boolean }
  | { ok: false; error: string }

export type CurrentFilePreviewResult =
  | { ok: true; state: CheckpointFilePreviewState }
  | { ok: false; error: string }

export const checkpointResourceSchema = z.object({
  kind: z.literal('exact-file'),
  path: z.string().min(1),
  before: fileStateSchema,
  after: fileStateSchema.optional(),
})

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
}
