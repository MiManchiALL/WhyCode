import { z } from 'zod'
import type { CheckpointFilePreview } from '@whycode/core'

const ref = z.string().min(1).max(1024).refine(value => !value.includes('\0'))
const commitHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u)
export const gitComparisonSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('branch'), baseRef: ref.nullable() }),
  z.object({ mode: z.enum(['uncommitted', 'unstaged', 'staged']) }),
  z.object({ mode: z.literal('commit'), commit: commitHash }),
])
export type GitComparison = z.infer<typeof gitComparisonSchema>
export const GIT_HISTORY_PAGE_SIZE = 40
export const GIT_MAX_FILES = 2000

export interface GitRef {
  ref: string
  name: string
  remote: boolean
}
export interface GitRepositoryInfo {
  root: string
  name: string
  branch: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  refs: GitRef[]
  remotes: string[]
  defaultBase: string | null
  staged: number
  unstaged: number
  untracked: number
  conflicts: number
}
export interface GitFileChange {
  path: string
  relativePath: string
  oldPath: string | null
  status: string
  added?: number
  removed?: number
  binary: boolean
}
export interface GitChanges {
  files: GitFileChange[]
  added: number
  removed: number
  untracked: number
  truncated: boolean
  baseLabel: string
}
export interface GitSnapshot {
  repository: GitRepositoryInfo | null
  changes: GitChanges | null
  changesError: string | null
}
export interface GitCommit {
  hash: string
  parents: string[]
  subject: string
  author: string
  date: string
}
export interface GitHistory { commits: GitCommit[]; hasMore: boolean }
export type GitFilePreview = CheckpointFilePreview

export const gitMutationSchema = z.object({
  expectedHead: commitHash.nullable(),
  expectedBranch: ref.nullable(),
  action: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), name: ref }),
    z.object({ kind: z.literal('switch'), ref }),
    z.object({ kind: z.literal('commit'), message: z.string().trim().min(1).max(10000).refine(value => !value.includes('\0')), scope: z.enum(['staged', 'all']) }),
    z.object({ kind: z.literal('push'), remote: ref }),
  ]),
})
export type GitMutation = z.infer<typeof gitMutationSchema>

export function largeGitChanges(changes: GitChanges): boolean {
  return changes.files.length > 20 || changes.added + changes.removed > 3000
}
