import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorktreeWorkspaceBinding } from '@whycode/core'
import type {
  StartWorkspaceRequest,
  WorkspaceCandidate,
  WorktreeStatus,
} from '../shared/workspace.ts'
import { requireGitSuccess, runGit } from './git-process.ts'
import {
  canonicalDirectory,
  assertWorktreeExecutionDirectory,
  ManagedWorktreeRegistry,
  pathExists,
  pathKey,
  samePath,
} from './managed-worktree-registry.ts'
import { copyWorktreeIncludes } from './worktree-include.ts'
import {
  assertGitWorktreeRoot,
  createDetachedWorktreeBranch,
  inspectGitWorkspace,
  isGitRepositoryDirectory,
  isWorktreePathRegistered,
  isWorktreeRegistered,
  managedWorktreeStateArgs,
  readWorktreeStatus,
} from './worktree-git.ts'

export interface AbandonedDraftCleanupResult {
  removed: string[]
  retained: string[]
  warnings: string[]
}

export class WorktreeManager {
  private readonly registry: ManagedWorktreeRegistry
  private readonly leases = new Map<string, string>()

  constructor(rootDirectory: string) {
    this.registry = new ManagedWorktreeRegistry(rootDirectory)
  }

  inspect(selectedDirectory: string): Promise<WorkspaceCandidate> {
    return inspectGitWorkspace(selectedDirectory)
  }

  async create(
    request: Extract<StartWorkspaceRequest, { mode: 'worktree' }>,
    worktreeId: string,
    ownerRuntimeId: string,
  ): Promise<WorktreeWorkspaceBinding> {
    const candidate = await this.inspect(request.selectedDirectory)
    assertCandidateCanCreate(candidate, request)

    const repositoryDirectory = candidate.repositoryDirectory!
    const baseCommit = candidate.baseCommit!
    const worktreeDirectory = await this.registry.expectedDirectory(
      repositoryDirectory,
      worktreeId,
    )
    const worktreeParent = dirname(worktreeDirectory)
    await mkdir(worktreeParent, { recursive: true, mode: 0o700 })
    if (!samePath(await canonicalDirectory(worktreeParent), worktreeParent)) {
      throw new Error('Worktree 受管父目录穿过符号链接或目录联接')
    }
    let binding: WorktreeWorkspaceBinding | null = null
    let reservedDirectory = false
    let gitCreationRan = false
    try {
      try {
        await mkdir(worktreeDirectory, { mode: 0o700 })
        reservedDirectory = true
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new Error(`Worktree 目标目录已存在：${worktreeDirectory}`)
        }
        throw error
      }
      const creation = await runGit(repositoryDirectory, [
        'worktree',
        'add',
        '--detach',
        worktreeDirectory,
        baseCommit,
      ], { timeoutMs: 60_000, outputLimit: 4 * 1024 * 1024 })
      gitCreationRan = true
      requireGitSuccess(creation, '创建隔离 Worktree')
      const canonicalWorktree = await canonicalDirectory(worktreeDirectory)
      binding = {
        mode: 'worktree',
        id: worktreeId,
        repositoryDirectory,
        worktreeDirectory: canonicalWorktree,
        relativeWorkingDirectory: candidate.relativeWorkingDirectory,
        baseCommit,
        baseRef: candidate.baseRef,
        createdAt: new Date().toISOString(),
      }
      await this.registry.validateBinding(binding)
      await copyWorktreeIncludes(repositoryDirectory, canonicalWorktree)
      await assertWorktreeExecutionDirectory(binding)
      await this.registry.create(binding)
      this.acquire(binding, ownerRuntimeId)
      return binding
    } catch (error) {
      const rollbackErrors: unknown[] = []
      let worktreeRolledBack = false
      if (gitCreationRan) {
        try {
          await this.rollbackCreatedWorktree(
            repositoryDirectory,
            worktreeId,
            worktreeDirectory,
          )
          worktreeRolledBack = true
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError)
        }
      } else if (reservedDirectory) {
        try {
          await this.registry.removeExpectedDirectory(
            repositoryDirectory,
            worktreeId,
            worktreeDirectory,
          )
          worktreeRolledBack = true
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError)
        }
      }
      if (binding && worktreeRolledBack) {
        await this.registry.removeManifest(binding)
          .catch((cleanupError) => rollbackErrors.push(cleanupError))
      }
      if (rollbackErrors.length) {
        throw new Error(
          `${errorMessage(error)}；Worktree 自动回滚未完成：${
            rollbackErrors.map(errorMessage).join('；')
          }`,
        )
      }
      throw error
    }
  }

  attachSession(binding: WorktreeWorkspaceBinding, sessionId: string): Promise<void> {
    return this.registry.attachSession(binding, sessionId)
  }

  async assertUsable(
    binding: WorktreeWorkspaceBinding,
    sessionId: string,
    ownerRuntimeId: string,
  ): Promise<void> {
    // session-start 与外置所有权清单无法跨文件原子提交；恢复时只补齐同一
    // 未认领清单，已属于其它会话时仍然 fail-closed。
    await this.assertGitWorktree(binding)
    await assertWorktreeExecutionDirectory(binding)
    await this.registry.attachSession(binding, sessionId)
    this.acquire(binding, ownerRuntimeId)
  }

  release(binding: WorktreeWorkspaceBinding, ownerRuntimeId: string): void {
    const key = pathKey(binding.worktreeDirectory)
    if (this.leases.get(key) === ownerRuntimeId) this.leases.delete(key)
  }

  async cleanupDraft(
    binding: WorktreeWorkspaceBinding,
    ownerRuntimeId: string,
  ): Promise<void> {
    this.release(binding, ownerRuntimeId)
    await this.cleanupUnclaimed(binding)
  }

  async cleanupAbandonedDrafts(
    knownSessionWorktreeIds: ReadonlySet<string>,
  ): Promise<AbandonedDraftCleanupResult> {
    const scan = await this.registry.unclaimedBindings()
    const result: AbandonedDraftCleanupResult = {
      removed: [],
      retained: [],
      warnings: [...scan.warnings],
    }
    for (const binding of scan.bindings) {
      // session-start 与清单关联之间存在窄崩溃窗口；只要当前事实源仍引用
      // 该 Worktree，就留给恢复流程补认领，启动清理不得抢先删除。
      if (knownSessionWorktreeIds.has(binding.id)) {
        result.retained.push(binding.id)
        continue
      }
      try {
        const removed = await this.cleanupUnclaimed(binding)
        result[removed ? 'removed' : 'retained'].push(binding.id)
      } catch (error) {
        result.retained.push(binding.id)
        result.warnings.push(`${binding.id}: ${errorMessage(error)}`)
      }
    }
    return result
  }

  async status(binding: WorktreeWorkspaceBinding): Promise<WorktreeStatus> {
    await this.assertGitWorktree(binding)
    return readWorktreeStatus(binding)
  }

  async createBranch(binding: WorktreeWorkspaceBinding, branchName: string): Promise<void> {
    await this.assertGitWorktree(binding)
    await createDetachedWorktreeBranch(binding, branchName)
  }

  async remove(
    binding: WorktreeWorkspaceBinding,
    discardChanges: boolean,
  ): Promise<void> {
    try {
      await this.registry.assertOwned(binding)
    } catch (error) {
      if (!isNotFound(error)) throw error
      if (await pathExists(binding.worktreeDirectory)) {
        throw new Error('Worktree 目录仍存在，但所有权记录已经缺失')
      }
      return
    }
    if (this.leases.has(pathKey(binding.worktreeDirectory))) {
      throw new Error('Worktree 仍被活动会话占用')
    }

    const worktreeExists = await pathExists(binding.worktreeDirectory)
    if (worktreeExists) await this.registry.assertManagedDirectory(binding)
    const repositoryUsable = await pathExists(binding.repositoryDirectory)
      && await isGitRepositoryDirectory(binding.repositoryDirectory)
    if (!repositoryUsable) {
      await this.removeWithoutRepository(binding, worktreeExists, discardChanges)
      return
    }
    if (worktreeExists && !discardChanges) {
      const status = await this.status(binding)
      if (status.dirty) throw new Error('Worktree 含未提交更改，已保留')
      if (!status.branch && status.headCommit !== binding.baseCommit) {
        throw new Error('Worktree 含尚未绑定分支的 detached 提交，已保留')
      }
    }

    if (worktreeExists) {
      const removed = await runGit(
        binding.repositoryDirectory,
        managedWorktreeStateArgs([
          'worktree',
          'remove',
          ...(discardChanges ? ['--force'] : []),
          binding.worktreeDirectory,
        ]),
        { timeoutMs: 60_000, outputLimit: 4 * 1024 * 1024 },
      )
      if (removed.code !== 0 && await isWorktreeRegistered(binding)) {
        requireGitSuccess(removed, '移除 Worktree')
      }
      await this.ensureDirectoryRemoved(binding, discardChanges)
    }

    requireGitSuccess(
      await runGit(binding.repositoryDirectory, ['worktree', 'prune']),
      '清理 Worktree 登记',
    )
    if (await isWorktreeRegistered(binding)) {
      throw new Error('Git 仍保留该 Worktree 登记')
    }
    await this.registry.removeManifest(binding)
  }

  private acquire(binding: WorktreeWorkspaceBinding, ownerRuntimeId: string): void {
    const key = pathKey(binding.worktreeDirectory)
    const owner = this.leases.get(key)
    if (owner && owner !== ownerRuntimeId) throw new Error('Worktree 已被其它活动会话占用')
    this.leases.set(key, ownerRuntimeId)
  }

  private async cleanupUnclaimed(
    binding: WorktreeWorkspaceBinding,
  ): Promise<boolean> {
    if (await this.registry.sessionId(binding)) return false
    const status = await this.status(binding)
    if (
      status.dirty
      || (!status.branch && status.headCommit !== binding.baseCommit)
    ) return false
    await this.remove(binding, false)
    return true
  }

  private async assertGitWorktree(binding: WorktreeWorkspaceBinding): Promise<void> {
    await this.registry.assertOwned(binding)
    await this.registry.assertManagedDirectory(binding)
    await assertGitWorktreeRoot(binding.worktreeDirectory)
    if (!await isWorktreeRegistered(binding)) {
      throw new Error('Git 已不再登记该受管 Worktree')
    }
  }

  private async ensureDirectoryRemoved(
    binding: WorktreeWorkspaceBinding,
    discardChanges: boolean,
  ): Promise<void> {
    if (!await pathExists(binding.worktreeDirectory)) return
    if (!discardChanges) {
      throw new Error('Git 未完整移除 Worktree 目录，已保留所有文件')
    }
    await this.registry.removeDirectory(binding)
    if (await pathExists(binding.worktreeDirectory)) {
      throw new Error('Worktree 目录删除后仍然存在')
    }
  }

  private async removeWithoutRepository(
    binding: WorktreeWorkspaceBinding,
    worktreeExists: boolean,
    discardChanges: boolean,
  ): Promise<void> {
    if (worktreeExists && !discardChanges) {
      throw new Error('原 Git 仓库不可用，无法确认 Worktree 是否干净，已保留')
    }
    if (worktreeExists) await this.registry.removeDirectory(binding)
    await this.registry.removeManifest(binding)
  }

  private async rollbackCreatedWorktree(
    repositoryDirectory: string,
    worktreeId: string,
    worktreeDirectory: string,
  ): Promise<void> {
    await runGit(
      repositoryDirectory,
      ['worktree', 'remove', '--force', worktreeDirectory],
      { timeoutMs: 60_000 },
    ).catch(() => null)
    if (await pathExists(worktreeDirectory)) {
      await this.registry.removeExpectedDirectory(
        repositoryDirectory,
        worktreeId,
        worktreeDirectory,
      )
    }
    if (await pathExists(worktreeDirectory)) {
      throw new Error('受管 Worktree 目录回滚后仍然存在')
    }
    requireGitSuccess(
      await runGit(repositoryDirectory, ['worktree', 'prune']),
      '回滚 Worktree 登记',
    )
    if (await isWorktreePathRegistered(repositoryDirectory, worktreeDirectory)) {
      throw new Error('回滚后 Git 仍保留该 Worktree 登记')
    }
  }
}

function assertCandidateCanCreate(
  candidate: WorkspaceCandidate,
  request: Extract<StartWorkspaceRequest, { mode: 'worktree' }>,
): void {
  if (
    candidate.worktreeUnavailableReason
    || !candidate.repositoryDirectory
    || !candidate.baseCommit
  ) {
    throw new Error(candidate.worktreeUnavailableReason ?? '当前目录不能创建 Worktree')
  }
  if (candidate.baseCommit !== request.expectedBaseCommit) {
    throw new Error('仓库 HEAD 已变化，请重新确认 Worktree 的基线')
  }
  if (candidate.dirty && !request.acknowledgeUncommittedChangesExcluded) {
    throw new Error('本地仓库有未提交更改；需明确确认它们不会进入隔离 Worktree')
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'ENOENT',
  )
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'EEXIST',
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
