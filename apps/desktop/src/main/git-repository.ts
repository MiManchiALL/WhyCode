import { localWorkspaceIO, type WorkspaceIO } from '@whycode/core'
import type { GitRepositoryInfo, GitHistory } from '../shared/git.ts'
import { GIT_HISTORY_PAGE_SIZE } from '../shared/git.ts'
import { runGit, requireGitSuccess, type GitCommandOptions } from './git-process.ts'
import { parsePorcelainStatus } from './git-status.ts'

export class GitRepository {
  readonly root: string
  readonly io: WorkspaceIO
  readonly managed: boolean
  readonly name: string
  constructor(root: string, io: WorkspaceIO = localWorkspaceIO, managedRepository?: string) {
    this.root = root; this.io = io; this.managed = managedRepository !== undefined
    this.name = io.path.basename(managedRepository ?? root)
  }

  run(args: readonly string[], options: GitCommandOptions = {}) {
    return runGit(this.root, [
      '--literal-pathspecs', ...(this.managed && this.io.platform === 'win32' ? ['-c', 'core.fileMode=false'] : []), ...args,
    ], { io: this.io, readOnly: true, ...options })
  }

  async text(args: readonly string[], action: string, options: GitCommandOptions = {}): Promise<string> {
    const result = await this.run(args, options)
    const output = requireGitSuccess(result, action)
    if (result.outputTruncated && options.readOnly !== false) throw new Error(`${action}结果过大，请缩小范围后重试`)
    return output
  }

  async commit(ref: string): Promise<string> {
    return (await this.text(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], '读取提交')).trim()
  }

  async info(): Promise<GitRepositoryInfo> {
    const [head, branch, refsText, statusText, remotesText] = await Promise.all([
      this.run(['rev-parse', '--verify', 'HEAD']),
      this.run(['symbolic-ref', '--quiet', '--short', 'HEAD']),
      this.text(['for-each-ref', '--format=%(refname)%00%(symref)%00%(upstream)', 'refs/heads', 'refs/remotes'], '读取分支'),
      this.text(['status', '--porcelain=v1', '-z', '--untracked-files=all'], '读取工作区状态', { outputLimit: 4 * 1024 * 1024 }),
      this.text(['remote'], '读取远端'),
    ])
    if (head.timedOut || branch.timedOut) throw new Error('读取 Git 状态超时')
    const branchName = branch.code === 0 ? branch.stdout.trim() : null
    const headCommit = head.code === 0 ? head.stdout.trim() : null
    const refs = refsText.trimEnd().split('\n').filter(Boolean).map(line => line.split('\0'))
    const upstream = refs.find(([ref]) => ref === `refs/heads/${branchName}`)?.[2] || null
    let ahead = 0, behind = 0
    if (headCommit && upstream && refs.some(([ref]) => ref === upstream)) {
      const counts = await this.text(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], '读取同步状态')
      ;[ahead, behind] = counts.trim().split(/\s+/u).map(Number) as [number, number]
    }
    const entries = parsePorcelainStatus(statusText)
    return {
      root: this.root, name: this.name, branch: branchName, head: headCommit, upstream, ahead, behind,
      refs: refs.filter(([, symbolic]) => !symbolic).map(([ref]) => ({
        ref: ref!, name: ref!.replace(/^refs\/(heads|remotes)\//u, ''), remote: ref!.startsWith('refs/remotes/'),
      })),
      remotes: remotesText.trim().split('\n').filter(Boolean),
      defaultBase: refs.some(([ref]) => ref === upstream) ? upstream
        : branchName && headCommit ? `refs/heads/${branchName}` : null,
      staged: entries.filter(entry => ![' ', '?'].includes(entry.code[0]!)).length,
      unstaged: entries.filter(entry => ![' ', '?'].includes(entry.code[1]!)).length,
      untracked: entries.filter(entry => entry.code === '??').length,
      conflicts: entries.filter(entry => entry.code.includes('U') || ['AA', 'DD'].includes(entry.code)).length,
    }
  }

  async history(skip: number): Promise<GitHistory> {
    const head = await this.run(['rev-parse', '--verify', 'HEAD'])
    if (head.code !== 0) return { commits: [], hasMore: false }
    const raw = await this.text(['log', '-z', `--max-count=${GIT_HISTORY_PAGE_SIZE + 1}`, `--skip=${skip}`,
      '--format=%H%x00%P%x00%s%x00%an%x00%aI', 'HEAD', '--'], '读取提交历史')
    const fields = raw.split('\0')
    const commits = []
    for (let i = 0; i + 4 < fields.length; i += 5) {
      commits.push({ hash: fields[i]!, parents: fields[i + 1]!.split(' ').filter(Boolean),
        subject: fields[i + 2]!, author: fields[i + 3]!, date: fields[i + 4]! })
    }
    return { commits: commits.slice(0, GIT_HISTORY_PAGE_SIZE), hasMore: commits.length > GIT_HISTORY_PAGE_SIZE }
  }
}

export async function openGitRepository(directory: string, io = localWorkspaceIO, managedRepository?: string): Promise<GitRepository | null> {
  const result = await runGit(directory, ['rev-parse', '--show-toplevel'], { readOnly: true, io })
  // SSH shell 命令合并输出，Git 的诊断会出现在 stdout。
  if (!result.timedOut && result.code !== 0 && /fatal: not a git repository\b/iu.test(result.stderr || result.stdout)) return null
  const root = requireGitSuccess(result, '读取 Git 仓库').trim()
  return new GitRepository(root, io, managedRepository)
}
