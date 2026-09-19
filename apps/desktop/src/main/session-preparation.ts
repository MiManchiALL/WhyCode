import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getSessionPaths,
  hasSessionDeletionMarker,
  REASONING_EFFORT_LEVELS,
  validateSessionId,
  type ReasoningEffortSelection,
} from '@whycode/core'
import type { DesktopSessionSummary } from '../shared/session.ts'
import type { RuntimeWorkspace } from '../shared/workspace.ts'
import { parseNewSessionState } from './new-session-state.ts'

export interface SessionPreparation {
  sessionId: string
  workspace: RuntimeWorkspace
  modelId: string
  reasoningEffort: ReasoningEffortSelection
  createdAt: string
  lastUserText: string
}

/** Journal 只能记录已经存在的工作区；创建前的登记与它共享目录、身份和删除边界。 */
export class SessionPreparations {
  private readonly root: string

  constructor(root: string) { this.root = root }

  async read(sessionId: string): Promise<SessionPreparation | null> {
    validateSessionId(sessionId)
    const paths = getSessionPaths(this.root, sessionId)
    if (await hasSessionDeletionMarker(paths)) return null
    try {
      await access(paths.transcript)
      return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      const value = JSON.parse(await readFile(join(paths.sessionDir, 'preparation.json'), 'utf8'))
      const { workspace } = parseNewSessionState({ runtimeId: sessionId, workspace: value.workspace })
      if (value.sessionId !== sessionId || typeof value.modelId !== 'string'
        || !value.modelId || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.lastUserText !== 'string'
        || !['default', ...REASONING_EFFORT_LEVELS].includes(value.reasoningEffort)) {
        throw new Error('会话准备记录无效')
      }
      return { ...value, workspace }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async register(input: Omit<SessionPreparation, 'createdAt'>): Promise<void> {
    validateSessionId(input.sessionId)
    const paths = getSessionPaths(this.root, input.sessionId)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    await mkdir(paths.sessionDir, { mode: 0o700 })
    try {
      await this.write({ ...input, createdAt: new Date().toISOString() })
    } catch (error) {
      await rmdir(paths.sessionDir).catch(() => {})
      throw error
    }
  }

  async updateWorkspace(sessionId: string, workspace: RuntimeWorkspace): Promise<void> {
    const record = await this.read(sessionId)
    if (!record) throw new Error('会话准备记录不存在')
    await this.write({ ...record, workspace })
  }

  async finish(sessionId: string): Promise<void> {
    validateSessionId(sessionId)
    await rm(join(getSessionPaths(this.root, sessionId).sessionDir, 'preparation.json'), { force: true })
  }

  private async write(record: SessionPreparation): Promise<void> {
    const path = join(getSessionPaths(this.root, record.sessionId).sessionDir, 'preparation.json')
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600, flush: true })
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

export function preparationSummary(record: SessionPreparation): DesktopSessionSummary {
  return {
    ...record,
    title: record.lastUserText.slice(0, 100) || '新会话',
    updatedAt: record.createdAt,
    referencedModelIds: [record.modelId],
    resumable: true,
    preparing: true,
    status: 'interrupted',
  }
}
