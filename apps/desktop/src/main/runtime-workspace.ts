import { localWorkspace, type WorkspaceBinding } from '@whycode/core'
import {
  pendingManagedWorkspace,
  pendingWorktreeRequest,
  pendingWorktreeWorkspace,
  type RuntimeWorkspace,
  type WorktreeStartRequest,
} from '../shared/workspace.ts'
import { DesktopSessionRuntime } from './desktop-session-runtime.ts'
import { ManagedWorkspaceManager } from './workspace.ts'
import { WorktreeManager } from './worktree-manager.ts'
import { canonicalDirectory } from './managed-worktree-registry.ts'

export function prepareDefaultRuntimeWorkspace(
  runtimeId: string,
  manager: ManagedWorkspaceManager,
): RuntimeWorkspace {
  return pendingManagedWorkspace(runtimeId, manager.plannedDirectory(runtimeId))
}

/** 校验新会话选择；Worktree 只保留瞬时意图，不在此阶段创建磁盘目录。 */
export async function prepareRuntimeWorkspace(
  target: unknown,
  worktrees: WorktreeManager,
  ssh?: import('./ssh/workspaces.ts').SshWorkspaces,
): Promise<RuntimeWorkspace> {
  if (!isRecord(target) || typeof target.selectedDirectory !== 'string') {
    throw new Error('新会话工作区请求无效')
  }
  if (target.mode === 'local') {
    return localWorkspace(await canonicalDirectory(target.selectedDirectory))
  }
  if (target.mode === 'ssh' && typeof target.connectionId === 'string' && ssh) {
    return ssh.select(target.connectionId, target.selectedDirectory)
  }
  if (!isWorktreeStartRequest(target)) {
    throw new Error('新会话 Worktree 请求无效')
  }
  const request = await worktrees.validateStartRequest(target)
  return pendingWorktreeWorkspace(request)
}

/** 首次发送消息或打开终端时，在运行时 FIFO 内物化受管工作区。 */
export async function materializeRuntimeWorkspace(
  runtime: DesktopSessionRuntime,
  worktrees: WorktreeManager,
  managedWorkspaces: ManagedWorkspaceManager,
): Promise<WorkspaceBinding> {
  const existing = runtime.workspaceBinding
  if (existing) return existing

  if (runtime.pendingManaged) {
    const binding = await managedWorkspaces.create(runtime.runtimeId)
    try {
      runtime.bindPendingManaged(binding)
      return binding
    } catch (error) {
      await managedWorkspaces.remove(binding).catch(() => undefined)
      throw error
    }
  }

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

/** 恢复已发送、尚未建立 Journal 的工作区；检出中断时只恢复登记，不重新执行发送。 */
export async function restoreSubmittedWorkspace(
  sessionId: string,
  workspace: RuntimeWorkspace,
  worktrees: WorktreeManager,
  managedWorkspaces: ManagedWorkspaceManager,
  persistWorkspace: (workspace: RuntimeWorkspace) => Promise<void>,
): Promise<RuntimeWorkspace> {
  const binding = workspace.mode === 'pending-managed'
    ? await managedWorkspaces.restoreDraft(sessionId)
    : workspace.mode === 'pending-worktree'
      ? await worktrees.restoreDraft(sessionId, sessionId)
      : workspace
  if (!binding) return workspace
  try {
    // 先固化目录身份，再认领引用，重启后不能把已认领目录再次当作未发送草稿。
    await persistWorkspace(binding)
    if (binding.mode === 'managed') {
      await managedWorkspaces.attachSession(binding, sessionId)
      await managedWorkspaces.assertUsable(binding, sessionId)
    }
    if (binding.mode === 'worktree') await worktrees.assertUsable(binding, sessionId, sessionId)
    return binding
  } catch (error) {
    if (binding.mode === 'worktree') worktrees.release(binding, sessionId)
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
