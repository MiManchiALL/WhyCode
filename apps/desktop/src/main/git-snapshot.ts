import type { GitComparison, GitSnapshot } from '../shared/git.ts'
import { readGitChanges } from './git-changes.ts'
import { GitNotFoundError } from './git-process.ts'
import type { GitRepository } from './git-repository.ts'

export async function readGitSnapshot(pendingRepository: Promise<GitRepository | null>, comparison: GitComparison): Promise<GitSnapshot> {
  try {
    const repo = await pendingRepository
    if (!repo) return { status: 'not-repository', repository: null, changes: null, changesError: null }
    const repository = await repo.info()
    try { return { status: 'ready', repository, changes: await readGitChanges(repo, repository, comparison), changesError: null } }
    catch (error) {
      if (error instanceof GitNotFoundError) throw error
      return { status: 'ready', repository, changes: null, changesError: error instanceof Error ? error.message : String(error) }
    }
  } catch (error) {
    if (error instanceof GitNotFoundError) return { status: 'git-not-found', repository: null, changes: null, changesError: null }
    throw error
  }
}
