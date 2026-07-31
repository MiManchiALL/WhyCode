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

export function workspaceDisplayDirectory(binding: WorkspaceBinding): string | null {
  if (binding.mode === 'none') return null
  if (binding.mode === 'local') return binding.workingDirectory
  if (binding.relativeWorkingDirectory === '.') return binding.worktreeDirectory
  const separator = binding.worktreeDirectory.includes('\\') ? '\\' : '/'
  return `${binding.worktreeDirectory}${separator}${
    binding.relativeWorkingDirectory.replaceAll('/', separator)
  }`
}
