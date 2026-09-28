import { readdir } from 'node:fs/promises'
import type { ManagedWorkspaceBinding, WorkspaceBinding, WorktreeWorkspaceBinding } from '@whycode/core'
import type { RetainedWorkspaceList, RetainedWorkspaceTarget, WorkspaceDeletionPreview, WorkspaceRetention } from '../shared/workspace-lifecycle.ts'
import { pathExists } from './managed-worktree-registry.ts'
import { directoriesOverlap } from './workspace-path.ts'
import { assertWorkspaceDirectory } from './workspace-retention.ts'
import { WorkspaceOwnershipError } from './workspace-ownership-error.ts'
import type { ManagedWorkspaceManager } from './workspace.ts'
import type { WorktreeManager } from './worktree-manager.ts'

export interface WorkspaceReference {
  sessionId: string | null
  directory: string
}

interface OwnedWorkspace {
  binding: ManagedWorkspaceBinding | WorktreeWorkspaceBinding
  sessionIds: string[]
  retention: WorkspaceRetention | null
}

/** 会话引用与用户选中的 Local/草稿路径共同决定目录能否清理。 */
export class WorkspaceLifecycle {
  private readonly managed: ManagedWorkspaceManager
  private readonly worktrees: WorktreeManager
  private readonly references: () => Promise<WorkspaceReference[]>
  private readonly cleaning = new Set<string>()

  constructor(
    managed: ManagedWorkspaceManager,
    worktrees: WorktreeManager,
    references: () => Promise<WorkspaceReference[]>,
  ) {
    this.managed = managed
    this.worktrees = worktrees
    this.references = references
  }

  assertAvailable(directory: string | null): void {
    if (directory && [...this.cleaning].some(path => directoriesOverlap(path, directory))) {
      throw new Error('这个工作目录正在清理，请等待完成后再选择')
    }
  }

  async isReferenced(directory: string): Promise<boolean> {
    return (await this.references()).some(ref => directoriesOverlap(directory, ref.directory))
  }

  private async withCleanup<T>(record: OwnedWorkspace, operation: () => Promise<T>): Promise<T> {
    const directory = directoryOf(record)
    this.assertAvailable(directory)
    this.cleaning.add(directory)
    try { return await operation() } finally { this.cleaning.delete(directory) }
  }

  async preview(sessionId: string, workspace: WorkspaceBinding | undefined): Promise<WorkspaceDeletionPreview> {
    if (workspace?.mode === 'local' || workspace?.mode === 'ssh') {
      return { directory: workspace.workingDirectory, disposition: workspace.mode === 'ssh' ? 'remote' : 'local', warning: null }
    }
    try {
      const owned = await this.resolve(sessionId, workspace)
      if (!owned) return { directory: null, disposition: 'missing', warning: null }
      return await this.inspect(owned, sessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceOwnershipError)) throw error
      return { directory: null, disposition: 'unverified', warning: error.message }
    }
  }

  async release(
    sessionId: string, workspace: WorkspaceBinding | undefined, name: string, deleteDirectory: boolean,
  ): Promise<string | undefined> {
    if (workspace?.mode === 'none' || workspace?.mode === 'ssh') return
    try {
      if (workspace?.mode === 'local') {
        // 用户重新以本地项目使用过的保留目录，只更新时间，不获得删除本地目录的权限。
        for (const record of (await this.records()).records) {
          if (!record.retention || !directoriesOverlap(directoryOf(record), workspace.workingDirectory)
            || await this.shared(record, sessionId)) continue
          const options = { deleteDirectory: false, protectDirectory: true, name }
          if (record.binding.mode === 'managed') await this.managed.detachSession(record.binding, sessionId, options)
          else await this.worktrees.detachSession(record.binding, sessionId, options)
        }
        return
      }
      const owned = await this.resolve(sessionId, workspace)
      if (!owned) return
      return await this.withCleanup(owned, async () => {
        const protectDirectory = await this.shared(owned, sessionId)
        const options = { deleteDirectory, protectDirectory, name: name.trim().slice(0, 200) || '保留的工作区' }
        if (owned.binding.mode === 'managed') {
          await this.managed.detachSession(owned.binding, sessionId, options)
        } else {
          await this.worktrees.detachSession(owned.binding, sessionId, options)
        }
        if (deleteDirectory && protectDirectory) return '工作目录仍被其它会话使用，已保留全部文件。'
      })
    } catch (error) {
      if (!(error instanceof WorkspaceOwnershipError)) throw error
      return `${error.message}，项目文件已保留。`
    }
  }

  async list(): Promise<RetainedWorkspaceList> {
    const [scan, references] = await Promise.all([this.records(), this.references()])
    return {
      workspaces: scan.records.flatMap(record => {
        if (!record.retention || record.sessionIds.length
          || references.some(ref => directoriesOverlap(directoryOf(record), ref.directory))) return []
        return [{ id: record.binding.id, mode: record.binding.mode, directory: directoryOf(record), ...record.retention }]
      }).sort((a, b) => b.retainedAt.localeCompare(a.retainedAt) || a.id.localeCompare(b.id)),
      warnings: scan.warnings,
    }
  }

  async previewRetained(target: RetainedWorkspaceTarget): Promise<WorkspaceDeletionPreview> {
    return this.inspect(await this.retained(target))
  }

  async openRetained(target: RetainedWorkspaceTarget, openDirectory: (path: string) => Promise<void>): Promise<void> {
    const record = await this.retained(target)
    const directory = directoryOf(record)
    if (!await assertWorkspaceDirectory(directory)) throw new Error('工作目录已不存在，可以清理这条记录')
    await openDirectory(directory)
  }

  async renameRetained(target: RetainedWorkspaceTarget, name: string): Promise<void> {
    const { binding } = await this.retained(target)
    if (binding.mode === 'managed') await this.managed.renameRetained(binding.id, name)
    else await this.worktrees.renameRetained(binding, name)
  }

  async deleteRetained(target: RetainedWorkspaceTarget): Promise<void> {
    const record = await this.retained(target)
    await this.withCleanup(record, async () => {
      if (await this.shared(record)) throw new Error('工作目录已被其它会话使用，请先关闭关联会话')
      if (record.binding.mode === 'managed') await this.managed.deleteRetained(record.binding.id)
      else await this.worktrees.deleteRetained(record.binding)
    })
  }

  private async retained(target: RetainedWorkspaceTarget): Promise<OwnedWorkspace> {
    if (!target || (target.mode !== 'managed' && target.mode !== 'worktree') || typeof target.id !== 'string') {
      throw new Error('工作区标识无效')
    }
    const record = (await this.records()).records.find(record =>
      record.binding.mode === target.mode && record.binding.id === target.id)
    if (!record?.retention || record.sessionIds.length || await this.shared(record)) {
      throw new Error('工作区已不在保留列表中，请刷新')
    }
    return record
  }

  private async inspect(record: OwnedWorkspace, sessionId?: string): Promise<WorkspaceDeletionPreview> {
    const directory = directoryOf(record)
    if (await this.shared(record, sessionId)) return { directory, disposition: 'shared', warning: null }
    if (!await assertWorkspaceDirectory(directory)) return { directory, disposition: 'missing', warning: null }
    const empty = (await readdir(directory)).length === 0
    return {
      directory, disposition: empty ? 'empty' : 'optional',
      warning: record.binding.mode === 'worktree'
        ? '工作目录中的文件将被删除，未提交改动会丢失；未保存到分支的独有提交可能丢失。已有 Git 分支及其提交会保留。'
        : null,
    }
  }

  private async shared(record: OwnedWorkspace, sessionId?: string): Promise<boolean> {
    if (record.sessionIds.some(id => id !== sessionId)) return true
    return (await this.references()).some(ref =>
      (!sessionId || ref.sessionId !== sessionId) && directoriesOverlap(directoryOf(record), ref.directory))
  }

  private async resolve(sessionId: string, workspace: WorkspaceBinding | undefined): Promise<OwnedWorkspace | null> {
    if (workspace?.mode === 'none' || workspace?.mode === 'local' || workspace?.mode === 'ssh') return null
    if (!workspace) {
      const scan = await this.records()
      const found = scan.records.find(record => record.sessionIds.includes(sessionId))
      if (!found && scan.warnings.length) throw new WorkspaceOwnershipError('无法确认工作区归属')
      return found ?? null
    }
    try {
      if (workspace.mode === 'managed') {
        const manifest = await this.managed.inspect(workspace)
        return { binding: workspace, sessionIds: manifest.sessionIds, retention: manifest.retention }
      }
      return await this.worktrees.inspectBinding(workspace)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (!await pathExists(workspace.mode === 'managed' ? workspace.workingDirectory : workspace.worktreeDirectory)) return null
      throw new WorkspaceOwnershipError('工作区所有权记录缺失')
    }
  }

  private async records(): Promise<{ records: OwnedWorkspace[]; warnings: string[] }> {
    const [managed, worktrees] = await Promise.all([this.managed.records(), this.worktrees.records()])
    return {
      records: [...managed.records.map(record => ({
        binding: { mode: 'managed' as const, id: record.id, createdAt: record.createdAt, workingDirectory: record.workingDirectory },
        sessionIds: record.sessionIds, retention: record.retention,
      })), ...worktrees.records],
      warnings: [...managed.warnings, ...worktrees.warnings],
    }
  }
}

function directoryOf(record: OwnedWorkspace): string {
  return record.binding.mode === 'managed' ? record.binding.workingDirectory : record.binding.worktreeDirectory
}
