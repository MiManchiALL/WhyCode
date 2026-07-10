import { randomUUID } from 'node:crypto'
import { rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  SESSION_SCHEMA_VERSION,
  sessionMetadataSchema,
  type SessionEntry,
  type SessionMetadata,
} from './types.ts'

const TRANSCRIPT_FILE = 'transcript.jsonl'
const METADATA_FILE = 'metadata.json'
const CHECKPOINTS_DIR = 'checkpoints'

export interface SessionPaths {
  sessionDir: string
  transcript: string
  metadata: string
  checkpoints: string
}

export function getSessionPaths(rootDir: string, sessionId: string): SessionPaths {
  const sessionDir = join(rootDir, sessionId)
  return {
    sessionDir,
    transcript: join(sessionDir, TRANSCRIPT_FILE),
    metadata: join(sessionDir, METADATA_FILE),
    checkpoints: join(sessionDir, CHECKPOINTS_DIR),
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

function normalizePath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}
