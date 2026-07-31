import { localWorkspace, type WorkspaceBinding } from '@whycode/core'
import {
  pendingWorktreeRequest,
  pendingWorktreeWorkspace,
  type RuntimeWorkspace,
  type WorktreeStartRequest,
} from '../shared/workspace.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { WorktreeManager } from './worktree-manager.ts'

/** 校验新会话选择；Worktree 只保留瞬时意图，不在此阶段创建磁盘目录。 */
export async function prepareRuntimeWorkspace(
  target: unknown,
  worktrees: WorktreeManager,
): Promise<RuntimeWorkspace> {
  if (!isRecord(target) || typeof target.selectedDirectory !== 'string') {
    throw new Error('新会话工作区请求无效')
  }
  if (target.mode === 'local') {
    const candidate = await worktrees.inspect(target.selectedDirectory)
    return localWorkspace(candidate.selectedDirectory)
  }
  if (!isWorktreeStartRequest(target)) {
    throw new Error('新会话 Worktree 请求无效')
  }
  const request = await worktrees.validateStartRequest(target)
  return pendingWorktreeWorkspace(request)
}

/** 首条消息初始化会话时，把待创建选择一次性转换为真实受管 Worktree。 */
export async function materializeRuntimeWorkspace(
  runtime: DesktopSessionRuntime,
  worktrees: WorktreeManager,
): Promise<WorkspaceBinding> {
  const existing = runtime.workspaceBinding
  if (existing) return existing

  const pending = runtime.pendingWorktree
  if (!pending) throw new Error('当前运行时没有可用的工作区')
  const binding = await worktrees.create(
    pendingWorktreeRequest(pending),
    runtime.runtimeId,
    runtime.runtimeId,
  )
  try {
    runtime.bindPendingWorktree(binding)
    return binding
  } catch (error) {
    try {
      await worktrees.cleanupDraft(binding, runtime.runtimeId)
    } catch (cleanupError) {
      throw new Error(
        `${errorMessage(error)}；Worktree 状态转换回滚失败：${errorMessage(cleanupError)}`,
      )
    }
    throw error
  }
}

function isWorktreeStartRequest(value: Record<string, unknown>): value is WorktreeStartRequest {
  return value.mode === 'worktree'
    && typeof value.selectedDirectory === 'string'
    && (value.baseRef === null || (
      typeof value.baseRef === 'string'
      && value.baseRef.length > 0
    ))
    && typeof value.expectedBaseCommit === 'string'
    && typeof value.acknowledgeUncommittedChangesExcluded === 'boolean'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
