import { constants } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { requireGitSuccess, runGit } from './git-process.ts'

const INCLUDE_FILE = '.worktreeinclude'
const MAX_INCLUDE_BYTES = 64 * 1024
const MAX_COPIED_FILES = 10_000
const MAX_COPIED_BYTES = 512 * 1024 * 1024

interface CopyBudget {
  files: number
  bytes: number
}

export async function copyWorktreeIncludes(
  sourceRoot: string,
  worktreeRoot: string,
): Promise<void> {
  const includePath = join(sourceRoot, INCLUDE_FILE)
  const includeStat = await stat(includePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!includeStat) return
  if (!includeStat.isFile() || includeStat.size > MAX_INCLUDE_BYTES) {
    throw new Error(`${INCLUDE_FILE} 必须是小于 64 KiB 的普通文件`)
  }

  const entries = parseIncludeEntries(await readFile(includePath, 'utf8'))
  const budget: CopyBudget = { files: 0, bytes: 0 }
  for (const entry of entries) {
    await assertIgnored(sourceRoot, entry)
    await assertSourcePathSafe(sourceRoot, entry)
    await copyEntry(
      join(sourceRoot, ...entry.split('/')),
      join(worktreeRoot, ...entry.split('/')),
      worktreeRoot,
      budget,
    )
  }
}

function parseIncludeEntries(text: string): string[] {
  const entries = new Set<string>()
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const normalized = line.replaceAll('\\', '/').replace(/\/+$/u, '')
    const segments = normalized.split('/')
    if (
      isAbsolute(line)
      || /^[a-z]:/iu.test(normalized)
      || segments.some((segment) => (
        !segment
        || segment === '.'
        || segment === '..'
        || segment.includes('\0')
        || segment.includes(':')
        || /[. ]$/u.test(segment)
      ))
      || /[*?[\]]/u.test(normalized)
    ) {
      throw new Error(
        `${INCLUDE_FILE} 只接受不含通配符、导航段、盘符和尾随点/空格的仓库相对路径：${line}`,
      )
    }
    entries.add(normalized)
  }
  return [...entries]
}

async function assertIgnored(sourceRoot: string, entry: string): Promise<void> {
  const result = await runGit(
    sourceRoot,
    ['check-ignore', '-q', '--', entry],
    { readOnly: true },
  )
  if (result.code === 1 && !result.timedOut) {
    throw new Error(`${INCLUDE_FILE} 只能复制已被 Git 忽略的路径：${entry}`)
  }
  if (result.code !== 0) requireGitSuccess(result, `检查 ${entry} 的 Git 忽略状态`)
}

async function assertSourcePathSafe(sourceRoot: string, entry: string): Promise<void> {
  let current = sourceRoot
  for (const segment of entry.split('/')) {
    current = join(current, segment)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new Error(`${INCLUDE_FILE} 引用的路径不存在：${entry}`)
      }
      throw error
    })
    if (info.isSymbolicLink()) {
      throw new Error(`${INCLUDE_FILE} 不允许复制符号链接或穿过符号链接：${entry}`)
    }
  }
}

async function copyEntry(
  source: string,
  destination: string,
  worktreeRoot: string,
  budget: CopyBudget,
): Promise<void> {
  const sourceInfo = await lstat(source)
  if (sourceInfo.isSymbolicLink()) {
    throw new Error(`Worktree 附加文件包含符号链接：${source}`)
  }
  await ensureDestinationParent(worktreeRoot, dirname(destination))
  if (sourceInfo.isDirectory()) {
    await mkdir(destination)
    const children = await readdir(source, { withFileTypes: true })
    for (const child of children) {
      await copyEntry(
        join(source, child.name),
        join(destination, child.name),
        worktreeRoot,
        budget,
      )
    }
    return
  }
  if (!sourceInfo.isFile()) throw new Error(`Worktree 附加路径不是普通文件或目录：${source}`)
  budget.files++
  budget.bytes += sourceInfo.size
  if (budget.files > MAX_COPIED_FILES || budget.bytes > MAX_COPIED_BYTES) {
    throw new Error(
      `${INCLUDE_FILE} 复制上限为 ${MAX_COPIED_FILES} 个文件、512 MiB，请缩小范围`,
    )
  }
  await copyFile(source, destination, constants.COPYFILE_EXCL)
}

async function ensureDestinationParent(worktreeRoot: string, parent: string): Promise<void> {
  const relativeParent = relative(worktreeRoot, parent)
  if (relativeParent.startsWith('..') || isAbsolute(relativeParent)) {
    throw new Error('Worktree 附加文件目标越过受管目录')
  }
  let current = worktreeRoot
  for (const segment of relativeParent.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (!info) {
      await mkdir(current)
    } else if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Worktree 附加文件目标父路径不安全：${current}`)
    }
  }
}
