import type { GitRepositoryInfo } from '../../shared/git.ts'
import type { GitPage } from './right-panel-state.ts'

export function gitComparisonRefs(repository: GitRepositoryInfo | null | undefined) {
  return repository?.refs.filter(ref => repository.branch === null || ref.ref !== `refs/heads/${repository.branch}`) ?? []
}

export function gitOverviewPage(page: GitPage, repository: GitRepositoryInfo | null | undefined): GitPage {
  const refs = gitComparisonRefs(repository)
  const baseRef = [page.baseRef, repository?.defaultBase].find(base => refs.some(ref => ref.ref === base)) ?? null
  return { ...page, mode: baseRef ? 'branch' : 'uncommitted', baseRef }
}
