import { join } from 'node:path'
import { z } from 'zod'

const gitCommitSchema = z.string().regex(
  /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i,
  'Git commit 必须是完整对象 ID',
)

const repositoryRelativeDirectorySchema = z.string().refine(
  (value) => value === '.' || (
    !value.startsWith('/')
    && !/^[a-z]:/iu.test(value)
    && !value.includes('\\')
    && value.split('/').every((segment) =>
      Boolean(segment)
      && segment !== '.'
      && segment !== '..'
      && !segment.includes('\0')
      && !segment.includes(':')
      && !/[. ]$/u.test(segment)
    )
  ),
  'Worktree 相对目录必须是规范的仓库内路径',
)

export const noWorkspaceBindingSchema = z.object({
  mode: z.literal('none'),
})

export const localWorkspaceBindingSchema = z.object({
  mode: z.literal('local'),
  workingDirectory: z.string().min(1),
})

export const managedWorkspaceBindingSchema = z.object({
  mode: z.literal('managed'),
  id: z.string().uuid(),
  workingDirectory: z.string().min(1),
  createdAt: z.string().datetime(),
})

export const worktreeWorkspaceBindingSchema = z.object({
  mode: z.literal('worktree'),
  id: z.string().uuid(),
  repositoryDirectory: z.string().min(1),
  worktreeDirectory: z.string().min(1),
  relativeWorkingDirectory: repositoryRelativeDirectorySchema,
  baseCommit: gitCommitSchema,
  baseRef: z.string().min(1).nullable(),
  createdAt: z.string().datetime(),
})

export const workspaceBindingSchema = z.discriminatedUnion('mode', [
  noWorkspaceBindingSchema,
  localWorkspaceBindingSchema,
  managedWorkspaceBindingSchema,
  worktreeWorkspaceBindingSchema,
])

export type WorkspaceBinding = z.infer<typeof workspaceBindingSchema>
export type ManagedWorkspaceBinding = Extract<WorkspaceBinding, { mode: 'managed' }>
export type WorktreeWorkspaceBinding = Extract<WorkspaceBinding, { mode: 'worktree' }>

export function localWorkspace(workingDirectory: string | null): WorkspaceBinding {
  return workingDirectory
    ? { mode: 'local', workingDirectory }
    : { mode: 'none' }
}

export function workspaceWorkingDirectory(binding: WorkspaceBinding): string | null {
  if (binding.mode === 'none') return null
  if (binding.mode === 'local' || binding.mode === 'managed') {
    return binding.workingDirectory
  }
  if (binding.relativeWorkingDirectory === '.') return binding.worktreeDirectory
  return join(
    binding.worktreeDirectory,
    ...binding.relativeWorkingDirectory.split('/'),
  )
}
