import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { IGNORED_DIRS } from '../fs-utils.ts'

const DIRECTORY_BATCH_SIZE = 32
const MAX_SCANNED_FILES = 200_000

export interface CollectedFiles {
  files: string[]
  truncated: boolean
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const error = new Error('搜索已被中止')
  error.name = 'AbortError'
  throw error
}

/** ripgrep 不可用时的有界并发遍历；不跟随目录符号链接，避免循环。 */
export async function collectFiles(
  root: string,
  signal: AbortSignal,
): Promise<CollectedFiles> {
  const files: string[] = []
  const directories = [root]

  while (directories.length > 0 && files.length < MAX_SCANNED_FILES) {
    throwIfAborted(signal)
    const batch = directories.splice(0, DIRECTORY_BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async (dir) => ({
        dir,
        entries: await readdir(dir, { withFileTypes: true }).catch(() => []),
      })),
    )
    for (const { dir, entries } of results) {
      for (const entry of entries) {
        if (IGNORED_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) directories.push(full)
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
  return new RegExp(`^${source}$`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
