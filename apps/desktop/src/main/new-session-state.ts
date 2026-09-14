import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { validateSessionId, workspaceBindingSchema } from '@whycode/core'
import type { RuntimeWorkspace } from '../shared/workspace.ts'

export interface NewSessionState {
  runtimeId: string
  workspace: RuntimeWorkspace
}

/** 唯一未发送会话的工作区身份；输入草稿由 Renderer 独立保存，不进入 Journal。 */
export class NewSessionStateStore {
  private current: NewSessionState | null = null
  private tail: Promise<void> = Promise.resolve()
  private readonly path: string

  constructor(path: string) { this.path = path }

  get value(): NewSessionState | null { return this.current }

  async initialize(): Promise<void> {
    try {
      this.current = parseState(JSON.parse(await readFile(this.path, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  set(state: NewSessionState | null): Promise<void> {
    return this.enqueue(() => this.write(state))
  }

  consume(runtimeId: string): Promise<void> {
    return this.enqueue(async () => {
      if (this.current?.runtimeId === runtimeId) await this.write(null)
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const write = this.tail.then(operation)
    this.tail = write.catch(() => {})
    return write
  }

  private async write(state: NewSessionState | null): Promise<void> {
    if (JSON.stringify(this.current) === JSON.stringify(state)) return
    if (state) {
      parseState(state)
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx', flush: true })
        await rename(temporary, this.path)
      } finally {
        await rm(temporary, { force: true }).catch(() => {})
      }
    } else {
      await rm(this.path, { force: true })
    }
    this.current = state
  }
}

function parseState(value: unknown): NewSessionState {
  if (!value || typeof value !== 'object' || !('runtimeId' in value) || !('workspace' in value)
    || typeof value.runtimeId !== 'string') throw new Error('新会话草稿身份无效')
  validateSessionId(value.runtimeId)
  const workspace = value.workspace
  if (workspace && typeof workspace === 'object' && 'mode' in workspace) {
    if (workspace.mode === 'pending-managed' && 'id' in workspace && workspace.id === value.runtimeId
      && 'workingDirectory' in workspace && typeof workspace.workingDirectory === 'string') {
      return { runtimeId: value.runtimeId, workspace: {
        mode: 'pending-managed', id: value.runtimeId, workingDirectory: workspace.workingDirectory,
      } }
    }
    if (workspace.mode === 'pending-worktree'
      && 'selectedDirectory' in workspace && typeof workspace.selectedDirectory === 'string'
      && 'baseRef' in workspace && (workspace.baseRef === null || typeof workspace.baseRef === 'string')
      && 'expectedBaseCommit' in workspace && typeof workspace.expectedBaseCommit === 'string'
      && 'acknowledgeUncommittedChangesExcluded' in workspace
      && typeof workspace.acknowledgeUncommittedChangesExcluded === 'boolean') {
      return { runtimeId: value.runtimeId, workspace: {
        mode: 'pending-worktree', selectedDirectory: workspace.selectedDirectory,
        baseRef: workspace.baseRef, expectedBaseCommit: workspace.expectedBaseCommit,
        acknowledgeUncommittedChangesExcluded: workspace.acknowledgeUncommittedChangesExcluded,
      } }
    }
  }
  return { runtimeId: value.runtimeId, workspace: workspaceBindingSchema.parse(workspace) }
}
