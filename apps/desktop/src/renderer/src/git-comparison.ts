import { useEffect } from 'react'
import type { GitRepositoryInfo } from '../../shared/git.ts'
import type { GitData } from './git-data.ts'
import type { GitPage } from './right-panel-state.ts'

export function gitComparisonRefs(repository: GitRepositoryInfo | null | undefined) {
  return repository?.refs.filter(ref => repository.branch === null || ref.ref !== `refs/heads/${repository.branch}`) ?? []
}

export function gitOverviewPage(page: GitPage, repository: GitRepositoryInfo | null | undefined): GitPage {
  const refs = gitComparisonRefs(repository)
  const baseRef = [page.baseRef, repository?.defaultBase].find(base => refs.some(ref => ref.ref === base)) ?? null
  return { ...page, mode: baseRef ? 'branch' : 'uncommitted', baseRef }
}

/** 会话级选择随最新仓库校正，不依赖变更页是否挂载。 */
export function useGitComparisonRecovery(page: GitPage | undefined, data: GitData, onUpdate: (page: GitPage) => void): void {
  useEffect(() => {
    const repository = data.snapshot?.repository
    if (!page || !repository || data.loading || data.error || data.unavailableReason) return
    const refs = gitComparisonRefs(repository)
    if (refs.some(ref => ref.ref === (page.baseRef ?? repository.defaultBase))) return
    const overview = gitOverviewPage(page, repository)
    const next = page.mode === 'branch' ? overview : { ...page, baseRef: overview.baseRef }
    if (next.baseRef !== page.baseRef || next.mode !== page.mode) onUpdate(next)
  }, [page, data.snapshot, data.loading, data.error, data.unavailableReason, onUpdate])
}
