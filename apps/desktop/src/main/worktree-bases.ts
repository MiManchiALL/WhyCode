import type { WorktreeBase } from '../shared/workspace.ts'
import { requireGitSuccess, runGit } from './git-process.ts'

const LOCAL_BRANCH_PREFIX = 'refs/heads/'
const GIT_COMMIT_PATTERN = /^[0-9a-f]{40,64}$/u

export async function readWorktreeBases(
  repositoryDirectory: string,
  headCommit: string,
): Promise<WorktreeBase[]> {
  const [headRef, localRefs] = await Promise.all([
    runGit(repositoryDirectory, ['symbolic-ref', '--quiet', 'HEAD'], { readOnly: true }),
    runGit(repositoryDirectory, [
      'for-each-ref',
      '--sort=refname',
      '--format=%(refname:strip=2)%09%(objectname)',
      LOCAL_BRANCH_PREFIX,
    ], { readOnly: true, outputLimit: 4 * 1024 * 1024 }),
  ])
  const branches = parseLocalBranches(
    requireGitSuccess(localRefs, '读取本地 Git 分支'),
    localRefs.outputTruncated,
  )
  const currentRef = readCurrentBranch(headRef)
  if (currentRef === null) {
    return [{ ref: null, commit: headCommit }, ...branches]
  }

  const current = branches.find((branch) => branch.ref === currentRef)
  if (!current) throw new Error(`当前 Git 分支 ${currentRef} 未出现在本地分支列表中`)
  if (current.commit !== headCommit) {
    throw new Error(`当前 Git 分支 ${currentRef} 在检查期间发生变化，请重试`)
  }
  return [current, ...branches.filter((branch) => branch.ref !== currentRef)]
}

function readCurrentBranch(
  result: Awaited<ReturnType<typeof runGit>>,
): string | null {
  if (result.code === 1 && !result.timedOut) return null
  const fullRef = requireGitSuccess(result, '读取当前 Git 分支').trim()
  if (!fullRef.startsWith(LOCAL_BRANCH_PREFIX)) {
    throw new Error(`当前 Git HEAD 指向不支持的引用 ${fullRef}`)
  }
  return fullRef.slice(LOCAL_BRANCH_PREFIX.length)
}

function parseLocalBranches(output: string, truncated: boolean): WorktreeBase[] {
  if (truncated) throw new Error('本地 Git 分支列表超过读取上限')
  return output.split(/\r?\n/u).filter(Boolean).map((line) => {
    const separator = line.indexOf('\t')
    const ref = line.slice(0, separator)
    const commit = line.slice(separator + 1)
    if (separator <= 0 || !GIT_COMMIT_PATTERN.test(commit)) {
      throw new Error('本地 Git 分支列表格式无效')
    }
    return { ref, commit }
  })
}
