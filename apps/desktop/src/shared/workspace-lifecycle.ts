export interface WorkspaceRetention {
  name: string
  retainedAt: string
}

export interface RetainedWorkspace extends WorkspaceRetention {
  id: string
  mode: 'managed' | 'worktree'
  directory: string
}

export type RetainedWorkspaceTarget = Pick<RetainedWorkspace, 'id' | 'mode'>

export interface WorkspaceDeletionPreview {
  directory: string | null
  disposition: 'local' | 'shared' | 'empty' | 'optional' | 'unverified' | 'missing'
  /** 只在用户选择删除目录时展示；Worktree 的 Git 分支始终保留。 */
  warning: string | null
}

export interface RetainedWorkspaceList {
  workspaces: RetainedWorkspace[]
  warnings: string[]
}
