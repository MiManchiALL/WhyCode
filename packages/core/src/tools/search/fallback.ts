import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import { IGNORED_DIRS } from '../fs-utils.ts'

const DIRECTORY_BATCH_SIZE = 32
const MAX_SCANNED_FILES = 200_000
const MAX_SCANNED_DIRECTORIES = 20_000

export interface CollectedFiles {
  files: string[]
  truncated: boolean
}

/** ripgrep 不可用时的有界并发遍历；不跟随目录符号链接，避免循环。 */
export async function collectFiles(
  root: string,
  signal: AbortSignal,
  io: WorkspaceIO = localWorkspaceIO,
): Promise<CollectedFiles> {
  const { readdir } = io.fs
  const { join } = io.path
  const files: string[] = []
  const directories = [root]
  let scannedDirectories = 0

  while (directories.length > 0 && files.length < MAX_SCANNED_FILES && scannedDirectories < MAX_SCANNED_DIRECTORIES) {
    signal.throwIfAborted()
    const batch = directories.splice(0, Math.min(DIRECTORY_BATCH_SIZE, MAX_SCANNED_DIRECTORIES - scannedDirectories))
    scannedDirectories += batch.length
    const results = await Promise.all(
      batch.map(async (dir) => ({
        dir,
        entries: await readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
          if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code ?? '')) return []
          throw error
        }),
      })),
    )
    signal.throwIfAborted()
    for (const { dir, entries } of results) {
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (directories.length + scannedDirectories >= MAX_SCANNED_DIRECTORIES) return { files, truncated: true }
          directories.push(full)
        }
        else if (entry.isFile()) files.push(full)
        if (files.length >= MAX_SCANNED_FILES) break
      }
      if (files.length >= MAX_SCANNED_FILES) break
    }
  }

  return {
    files,
    truncated: directories.length > 0 || files.length >= MAX_SCANNED_FILES,
  }
}

/** 支持常用的 *, **, ?, {a,b}；作为无 ripgrep 环境的兼容回退。 */
export function globToRegExp(pattern: string): RegExp {
  pattern = pattern.replaceAll('\\', '/')
  const basenameOnly = !pattern.includes('/')
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++
        if (pattern[i + 1] === '/') {
          i++
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else if (char === '{') {
      const end = pattern.indexOf('}', i + 1)
      if (end !== -1) {
        const choices = pattern
          .slice(i + 1, end)
          .split(',')
          .map(escapeRegExp)
        source += `(?:${choices.join('|')})`
        i = end
      } else {
        source += '\\{'
      }
    } else {
      source += escapeRegExp(char)
    }
  }
  return new RegExp(`${basenameOnly ? '(?:^|/)' : '^'}${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
