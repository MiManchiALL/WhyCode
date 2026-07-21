import { randomUUID } from 'node:crypto'
import { lstat, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  SESSION_SCHEMA_VERSION,
  sessionMetadataSchema,
  type SessionEntry,
  type SessionMetadata,
  type SessionSummary,
} from './types.ts'

const TRANSCRIPT_FILE = 'transcript.jsonl'
const METADATA_FILE = 'metadata.json'
const CHECKPOINTS_DIR = 'checkpoints'
const ATTACHMENTS_DIR = 'attachments'
const UNAVAILABLE_SESSION_REASON = '会话版本不兼容或数据损坏，无法恢复；可以安全删除'
export const SESSION_DELETION_PENDING_REASON = '会话删除未完成，仅可重试删除'
const DELETION_MARKERS_DIR = '.deleting'

const looseSessionMetadataSchema = z.object({
  sessionId: z.string().uuid(),
  projectDir: z.string().nullable().optional(),
  modelId: z.string().min(1).optional(),
  title: z.string().optional(),
  lastUserText: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
})

export interface SessionPaths {
  sessionDir: string
  transcript: string
  metadata: string
  checkpoints: string
  attachments: string
  deletionMarkersDir: string
  deletionMarker: string
}

export function getSessionDeletionMarkersDir(rootDir: string): string {
  return join(rootDir, DELETION_MARKERS_DIR)
}

export function getSessionPaths(rootDir: string, sessionId: string): SessionPaths {
  const sessionDir = join(rootDir, sessionId)
  const deletionMarkersDir = getSessionDeletionMarkersDir(rootDir)
  return {
    sessionDir,
    transcript: join(sessionDir, TRANSCRIPT_FILE),
    metadata: join(sessionDir, METADATA_FILE),
    checkpoints: join(sessionDir, CHECKPOINTS_DIR),
    attachments: join(sessionDir, ATTACHMENTS_DIR),
    deletionMarkersDir,
    // marker 必须位于被删目录之外，避免递归删除部分失败后重新暴露成可恢复会话。
    deletionMarker: join(deletionMarkersDir, sessionId),
  }
}

export function metadataFromStart(
  entry: Extract<SessionEntry, { type: 'session-start' }>,
): SessionMetadata {
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId: entry.sessionId,
    projectDir: entry.projectDir,
    modelId: entry.modelId,
    reasoningEffort: entry.reasoningEffort ?? 'default',
    title: '',
    lastUserText: '',
    createdAt: entry.timestamp,
    updatedAt: entry.timestamp,
    status: 'idle',
  }
}

export async function writeMetadata(
  path: string,
  metadata: SessionMetadata,
): Promise<void> {
  const parsed = sessionMetadataSchema.parse(metadata)
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flush: true,
  })
  await rename(tempPath, path)
}

export function resumableSessionSummary(metadata: SessionMetadata): SessionSummary {
  const { schemaVersion: _, ...summary } = metadata
  return { ...summary, resumable: true }
}

/**
 * 从不受当前持久化 schema 约束的旧 metadata 中提取展示字段。目录名已经由调用方
 * 校验为 UUID；这里绝不据此允许恢复，只为用户保留删除入口。
 */
export async function unavailableSessionSummary(
  paths: SessionPaths,
  sessionId: string,
  unavailableReason = UNAVAILABLE_SESSION_REASON,
): Promise<SessionSummary> {
  const directoryStat = await stat(paths.sessionDir).catch(() => null)
  const diskCreatedAt = directoryStat && directoryStat.birthtimeMs > 0
    ? directoryStat.birthtime.toISOString()
    : directoryStat?.mtime.toISOString() ?? new Date(0).toISOString()
  const diskUpdatedAt = directoryStat?.mtime.toISOString() ?? diskCreatedAt
  const loose = await readLooseMetadata(paths.metadata, sessionId)

  return {
    sessionId,
    ...(loose?.projectDir !== undefined ? { projectDir: loose.projectDir } : {}),
    modelId: loose?.modelId ?? null,
    title: loose?.title?.trim() || '无法恢复的会话',
    lastUserText: loose?.lastUserText ?? '',
    createdAt: loose?.createdAt ?? diskCreatedAt,
    updatedAt: loose?.updatedAt ?? diskUpdatedAt,
    status: 'unavailable',
    resumable: false,
    unavailableReason,
  }
}

export async function hasSessionDeletionMarker(paths: SessionPaths): Promise<boolean> {
  try {
    // marker 的语义是目录项存在；dangling symlink 也必须可见并可被 rm 清理。
    await lstat(paths.deletionMarker)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

export function validateSessionId(sessionId: string): void {
  if (!sessionMetadataSchema.shape.sessionId.safeParse(sessionId).success) {
    throw new Error(`无效会话 ID：${sessionId}`)
  }
}

export function isSessionId(value: string): boolean {
  return sessionMetadataSchema.shape.sessionId.safeParse(value).success
}

export function sameProject(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right
  return normalizePath(left) === normalizePath(right)
}

async function readLooseMetadata(
  path: string,
  expectedSessionId: string,
): Promise<z.infer<typeof looseSessionMetadataSchema> | null> {
  try {
    const parsed = looseSessionMetadataSchema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success && parsed.data.sessionId === expectedSessionId ? parsed.data : null
  } catch {
    return null
  }
}

function normalizePath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
