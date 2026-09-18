import { lstat, realpath, rmdir } from 'node:fs/promises'
import type { WorkspaceRetention } from '../shared/workspace-lifecycle.ts'
import { samePath } from './workspace-path.ts'
import { WorkspaceOwnershipError } from './workspace-ownership-error.ts'

export interface WorkspaceReleaseOptions {
  deleteDirectory: boolean
  name: string
  /** 也可能被以 Local 模式选中的会话或尚未发送的草稿使用。 */
  protectDirectory: boolean
}

/** 同一目录的引用变更与清理串行，不阻塞其它工作区的恢复和发送。 */
export class WorkspaceMutations {
  private readonly pending = new Map<string, Promise<void>>()

  run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(id) ?? Promise.resolve()).then(operation)
    const settled = next.then(() => undefined, () => undefined)
    this.pending.set(id, settled)
    void settled.then(() => { if (this.pending.get(id) === settled) this.pending.delete(id) })
    return next
  }
}

export function retainWorkspace(name: string, previous: WorkspaceRetention | null): WorkspaceRetention {
  return { name: previous?.name ?? workspaceName(name), retainedAt: new Date().toISOString() }
}

export function workspaceName(value: string): string {
  const name = value.trim()
  if (!name || name.length > 200) throw new Error('工作区名称应为 1～200 个字符')
  return name
}

export function parseWorkspaceRetention(value: unknown): WorkspaceRetention | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('工作区保留记录无效')
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || typeof record.retainedAt !== 'string'
    || !Number.isFinite(Date.parse(record.retainedAt))) throw new Error('工作区保留记录无效')
  return { name: workspaceName(record.name), retainedAt: record.retainedAt }
}

/** 空目录清理必须使用 rmdir；检查与删除之间新增的文件不能被递归删除。 */
export async function removeEmptyWorkspace(directory: string): Promise<boolean> {
  if (!await assertWorkspaceDirectory(directory)) return true
  try {
    await rmdir(directory)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return true
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return false
    throw error
  }
}

export async function assertWorkspaceDirectory(directory: string): Promise<boolean> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(directory), directory)) {
    throw new WorkspaceOwnershipError('工作区路径不是原有普通目录，文件已保留')
  }
  return true
}
