import { isAbsolute, relative } from 'node:path'
import type { WorktreeWorkspaceBinding } from '@whycode/core'
import type {
  WorkspaceCandidate,
  WorktreeStatus,
  WorktreeStatusEntry,
} from '../shared/workspace.ts'
import { requireGitSuccess, runGit } from './git-process.ts'
import { readWorktreeBases } from './worktree-bases.ts'
import {
  canonicalDirectory,
  samePath,
} from './managed-worktree-registry.ts'

const STATUS_ENTRY_LIMIT = 200
const DIFF_OUTPUT_LIMIT = 256 * 1024

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
  const [branch, head, statusResult, diff] = await Promise.all([
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
    runGit(
      binding.worktreeDirectory,
      managedWorktreeStateArgs([
        'diff',
        '--no-ext-diff',
        '--unified=3',
        'HEAD',
        '--',
      ]),
      { readOnly: true, outputLimit: DIFF_OUTPUT_LIMIT },
    ),
  ])
  const entries = parsePorcelainStatus(requireGitSuccess(statusResult, '读取 Worktree 状态'))
  return {
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    headCommit: requireGitSuccess(head, '读取 Worktree HEAD').trim(),
    dirty: entries.length > 0 || statusResult.outputTruncated,
    entries: entries.slice(0, STATUS_ENTRY_LIMIT),
    entriesTruncated: entries.length > STATUS_ENTRY_LIMIT || statusResult.outputTruncated,
    diff: requireGitSuccess(diff, '读取 Worktree 差异'),
    diffTruncated: diff.outputTruncated,
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

export async function createDetachedWorktreeBranch(
  binding: WorktreeWorkspaceBinding,
  branchName: string,
): Promise<void> {
  const normalizedName = branchName.trim()
  if (!normalizedName) throw new Error('分支名不能为空')
  const current = await runGit(
    binding.worktreeDirectory,
    ['symbolic-ref', '--quiet', '--short', 'HEAD'],
    { readOnly: true },
  )
  if (current.code === 0) throw new Error(`Worktree 已位于分支 ${current.stdout.trim()}`)
  requireGitSuccess(
    await runGit(
      binding.worktreeDirectory,
      ['check-ref-format', '--branch', normalizedName],
      { readOnly: true },
    ),
    '校验分支名',
  )
  requireGitSuccess(
    await runGit(binding.worktreeDirectory, ['switch', '-c', normalizedName]),
    '创建 Worktree 分支',
  )
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

function parsePorcelainStatus(output: string): WorktreeStatusEntry[] {
  const records = output.split('\0')
  const entries: WorktreeStatusEntry[] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const code = record.slice(0, 2)
    const target = record.slice(3)
    if (code.includes('R') || code.includes('C')) {
      const source = records[++index] ?? ''
      entries.push({ code, path: `${source} → ${target}` })
    } else {
      entries.push({ code, path: target })
    }
  }
  return entries
}

function repositoryRelativePath(repository: string, selected: string): string {
  const result = relative(repository, selected)
  if (result.startsWith('..') || isAbsolute(result)) {
    throw new Error('所选工作文件夹不在 Git 仓库工作树内')
  }
  return result ? result.replaceAll('\\', '/') : '.'
}
