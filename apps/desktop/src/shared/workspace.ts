import type { WorkspaceBinding } from '@whycode/core'

export interface WorktreeBase {
  ref: string | null
  commit: string
}

export interface WorkspaceCandidate {
  selectedDirectory: string
  repositoryDirectory: string | null
  relativeWorkingDirectory: string
  worktreeBases: WorktreeBase[]
  dirty: boolean
  changedFileCount: number
  worktreeUnavailableReason: string | null
}

export type StartWorkspaceRequest =
  | {
      mode: 'local'
      selectedDirectory: string
    }
  | {
      mode: 'worktree'
      selectedDirectory: string
      baseRef: string | null
      expectedBaseCommit: string
      acknowledgeUncommittedChangesExcluded: boolean
    }

export type WorktreeStartRequest = Extract<StartWorkspaceRequest, { mode: 'worktree' }>

/**
 * 尚未提交首条消息的 Worktree 选择。它只存在于 Main/Renderer 的运行时快照中，
 * 不属于会话持久化事实，也不代表磁盘上已经存在 Git Worktree。
 */
export interface PendingWorktreeWorkspace {
  mode: 'pending-worktree'
  selectedDirectory: string
  baseRef: string | null
  expectedBaseCommit: string
  acknowledgeUncommittedChangesExcluded: boolean
}

/** 新会话尚未发送首条消息时的受管默认目录计划；路径只展示，不代表目录已创建。 */
export interface PendingManagedWorkspace {
  mode: 'pending-managed'
  id: string
  workingDirectory: string
}

export type RuntimeWorkspace =
  | WorkspaceBinding
  | PendingManagedWorkspace
  | PendingWorktreeWorkspace

export interface WorktreeStatusEntry {
  code: string
  path: string
}

export interface WorktreeStatus {
  branch: string | null
  headCommit: string
  dirty: boolean
  entries: WorktreeStatusEntry[]
  entriesTruncated: boolean
  diff: string
  diffTruncated: boolean
}

export type WorkspaceActionResult<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; value: T })
  | { ok: false; error: string }

export function pendingWorktreeWorkspace(
  request: WorktreeStartRequest,
): PendingWorktreeWorkspace {
  return {
    mode: 'pending-worktree',
    selectedDirectory: request.selectedDirectory,
    baseRef: request.baseRef,
    expectedBaseCommit: request.expectedBaseCommit,
    acknowledgeUncommittedChangesExcluded: request.acknowledgeUncommittedChangesExcluded,
  }
}

export function pendingWorktreeRequest(
  workspace: PendingWorktreeWorkspace,
): WorktreeStartRequest {
  return {
    mode: 'worktree',
    selectedDirectory: workspace.selectedDirectory,
    baseRef: workspace.baseRef,
    expectedBaseCommit: workspace.expectedBaseCommit,
    acknowledgeUncommittedChangesExcluded: workspace.acknowledgeUncommittedChangesExcluded,
  }
}

export function pendingManagedWorkspace(
  id: string,
  workingDirectory: string,
): PendingManagedWorkspace {
  return { mode: 'pending-managed', id, workingDirectory }
}

export function workspaceDisplayDirectory(binding: RuntimeWorkspace): string | null {
  if (binding.mode === 'pending-worktree') return binding.selectedDirectory
  if (binding.mode === 'pending-managed') return binding.workingDirectory
  if (binding.mode === 'none') return null
  if (binding.mode === 'local' || binding.mode === 'managed') {
    return binding.workingDirectory
  }
  if (binding.relativeWorkingDirectory === '.') return binding.worktreeDirectory
  const separator = binding.worktreeDirectory.includes('\\') ? '\\' : '/'
  return `${binding.worktreeDirectory}${separator}${
    binding.relativeWorkingDirectory.replaceAll('/', separator)
  }`
}
