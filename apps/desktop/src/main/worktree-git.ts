import { isAbsolute, relative } from 'node:path'
import type { WorktreeWorkspaceBinding } from '@whycode/core'
import type { WorkspaceCandidate } from '../shared/workspace.ts'
import { requireGitSuccess, runGit } from './git-process.ts'
import { readWorktreeBases } from './worktree-bases.ts'
import { parsePorcelainStatus } from './git-status.ts'
import {
  canonicalDirectory,
  samePath,
} from './managed-worktree-registry.ts'

export interface WorktreeStatus {
  branch: string | null
  headCommit: string
  dirty: boolean
}

// Windows cannot faithfully check out Git's executable bit. Repositories copied
// from Unix sometimes keep core.filemode=true, which otherwise makes a brand-new
// Worktree look dirty even though every file byte still matches HEAD. Keep the
// override process-local so WhyCode never rewrites the user's repository config.
export function managedWorktreeStateArgs(args: readonly string[]): string[] {
  return process.platform === 'win32'
    ? ['-c', 'core.fileMode=false', ...args]
    : [...args]
}

export async function inspectGitWorkspace(
  selectedDirectory: string,
): Promise<WorkspaceCandidate> {
  const selected = await canonicalDirectory(selectedDirectory)
  let repositoryDirectory: string | null = null
  let relativeWorkingDirectory = '.'
  try {
    const topLevelResult = await runGit(
      selected,
      ['rev-parse', '--show-toplevel'],
      { readOnly: true },
    )
    if (topLevelResult.timedOut) {
      return unavailableCandidate(selected, '检查 Git 仓库超时')
    }
    if (topLevelResult.code !== 0) {
      return unavailableCandidate(selected, '所选文件夹不在 Git 仓库中')
    }

    repositoryDirectory = await canonicalDirectory(topLevelResult.stdout.trim())
    relativeWorkingDirectory = repositoryRelativePath(repositoryDirectory, selected)
    const head = await runGit(
      selected,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      { readOnly: true },
    )
    if (head.timedOut) {
      return {
        ...unavailableCandidate(selected, '读取 Git HEAD 超时'),
        repositoryDirectory,
        relativeWorkingDirectory,
      }
    }
    if (head.code !== 0) {
      return {
        ...unavailableCandidate(selected, 'Git 仓库还没有可用提交，需先创建首个提交'),
        repositoryDirectory,
        relativeWorkingDirectory,
      }
    }
    const headCommit = head.stdout.trim()

    const [worktreeBases, statusResult] = await Promise.all([
      readWorktreeBases(repositoryDirectory, headCommit),
      runGit(
        selected,
        managedWorktreeStateArgs([
          'status',
          '--porcelain=v1',
          '-z',
          '--untracked-files=all',
        ]),
        { readOnly: true, outputLimit: 4 * 1024 * 1024 },
      ),
    ])
    requireGitSuccess(statusResult, '读取 Git 工作区状态')
    const statusEntries = parsePorcelainStatus(statusResult.stdout)
    return {
      selectedDirectory: selected,
      repositoryDirectory,
      relativeWorkingDirectory,
      worktreeBases,
      dirty: statusEntries.length > 0 || statusResult.outputTruncated,
      changedFileCount: statusEntries.length,
      worktreeUnavailableReason: null,
    }
  } catch (error) {
    return {
      ...unavailableCandidate(
        selected,
        `Worktree 检查失败：${error instanceof Error ? error.message : String(error)}`,
      ),
      repositoryDirectory,
      relativeWorkingDirectory,
    }
  }
}

export async function assertGitWorktreeRoot(worktreeDirectory: string): Promise<void> {
  const topLevel = await runGit(
    worktreeDirectory,
    ['rev-parse', '--show-toplevel'],
    { readOnly: true },
  )
  const actualTopLevel = await canonicalDirectory(
    requireGitSuccess(topLevel, '验证 Worktree').trim(),
  )
  if (!samePath(actualTopLevel, worktreeDirectory)) {
    throw new Error('会话工作目录已不再是原受管 Worktree')
  }
}

export async function readWorktreeStatus(
  binding: WorktreeWorkspaceBinding,
): Promise<WorktreeStatus> {
  const [branch, head, statusResult] = await Promise.all([
    runGit(
      binding.worktreeDirectory,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      { readOnly: true },
    ),
    runGit(
      binding.worktreeDirectory,
      ['rev-parse', '--verify', 'HEAD^{commit}'],
      { readOnly: true },
    ),
    runGit(
      binding.worktreeDirectory,
      managedWorktreeStateArgs([
        'status',
        '--porcelain=v1',
        '-z',
        '--untracked-files=all',
      ]),
      { readOnly: true, outputLimit: 4 * 1024 * 1024 },
    ),
  ])
  const status = requireGitSuccess(statusResult, '读取 Worktree 状态')
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    headCommit: requireGitSuccess(head, '读取 Worktree HEAD').trim(),
    dirty: status.length > 0 || statusResult.outputTruncated,
  }
}

export async function isWorktreeRegistered(
  binding: WorktreeWorkspaceBinding,
): Promise<boolean> {
  return isWorktreePathRegistered(
    binding.repositoryDirectory,
    binding.worktreeDirectory,
  )
}

export async function isWorktreePathRegistered(
  repositoryDirectory: string,
  worktreeDirectory: string,
): Promise<boolean> {
  const list = requireGitSuccess(
    await runGit(
      repositoryDirectory,
      ['worktree', 'list', '--porcelain', '-z'],
      { readOnly: true, outputLimit: 4 * 1024 * 1024 },
    ),
    '读取 Worktree 登记',
  )
  return list.split('\0').some((line) =>
    line.startsWith('worktree ')
    && samePath(line.slice('worktree '.length), worktreeDirectory))
}

export async function isGitRepositoryDirectory(
  repositoryDirectory: string,
): Promise<boolean> {
  const result = await runGit(
    repositoryDirectory,
    ['rev-parse', '--git-dir'],
    { readOnly: true },
  ).catch(() => null)
  return result?.code === 0
}

function unavailableCandidate(
  selectedDirectory: string,
  reason: string,
): WorkspaceCandidate {
  return {
    selectedDirectory,
    repositoryDirectory: null,
    relativeWorkingDirectory: '.',
    worktreeBases: [],
    dirty: false,
    changedFileCount: 0,
    worktreeUnavailableReason: reason,
  }
}

function repositoryRelativePath(repository: string, selected: string): string {
  const result = relative(repository, selected)
  if (result.startsWith('..') || isAbsolute(result)) {
    throw new Error('所选工作文件夹不在 Git 仓库工作树内')
  }
  return result ? result.replaceAll('\\', '/') : '.'
}
