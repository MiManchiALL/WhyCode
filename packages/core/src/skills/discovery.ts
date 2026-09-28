import { localWorkspaceIO, workspacePathKey, type WorkspaceIO, type WorkspaceDirent } from '../workspace/io.ts'
import { findProjectRoot } from '../project-root.ts'
import type { SkillDiagnostic, SkillScope } from './types.ts'
import { SKILL_FILE_NAME } from './types.ts'
import { systemSkillsRoot, userSkillsRoot } from './system.ts'

const MAX_SCAN_DEPTH = 6
const MAX_DIRECTORIES_PER_ROOT = 2_000
export const MAX_SKILL_ENTRIES_PER_ROOT = 20_000

export interface DiscoveryRoot {
  path: string
  scope: SkillScope
}

export async function discoveryRoots(
  projectDir: string | null,
  homeDir: string | undefined,
  io: WorkspaceIO = localWorkspaceIO,
): Promise<DiscoveryRoot[]> {
  const { resolve, join } = io.path
  const roots: DiscoveryRoot[] = []
  if (projectDir) {
    const selected = resolve(projectDir)
    const projectRoot = await findProjectRoot(selected, io)
    const directories = directoriesBetween(projectRoot, selected, io).reverse()
    roots.push(...directories.map((directory) => ({
      path: join(directory, '.agents', 'skills'),
      scope: 'project' as const,
    })))
  }
  if (homeDir) {
    roots.push({ path: userSkillsRoot(homeDir, io.path), scope: 'user' })
    roots.push({ path: systemSkillsRoot(homeDir, io.path), scope: 'system' })
  }
  return roots
}

export async function discoverSkillFiles(
  root: string,
  diagnostics: SkillDiagnostic[],
  maxEntries = MAX_SKILL_ENTRIES_PER_ROOT,
  io: WorkspaceIO = localWorkspaceIO,
): Promise<string[]> {
  const { resolve, join } = io.path
  const files: string[] = []
  const absoluteRoot = resolve(root)
  if (!await validateRoot(absoluteRoot, diagnostics, io)) return files

  const queue: { path: string; depth: number }[] = [{ path: absoluteRoot, depth: 0 }]
  let queueIndex = 0
  let visitedDirectories = 0
  let visitedEntries = 0
  while (queueIndex < queue.length) {
    const current = queue[queueIndex++]!
    if (++visitedDirectories > MAX_DIRECTORIES_PER_ROOT) {
      diagnostics.push({ path: root, message: `目录扫描达到 ${MAX_DIRECTORIES_PER_ROOT} 个上限` })
      break
    }
    const entries = await readDirectory(current.path, diagnostics, io)
    if (!entries) continue
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      if (++visitedEntries > maxEntries) {
        diagnostics.push({ path: root, message: `目录条目扫描达到 ${maxEntries} 个上限` })
        return files
      }
      const path = join(current.path, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isFile() && entry.name === SKILL_FILE_NAME && current.depth > 0) {
        files.push(resolve(path))
        continue
      }
      if (
        entry.isDirectory()
        && current.depth < MAX_SCAN_DEPTH
        && !entry.name.startsWith('.')
      ) {
        // 复核目录身份后再入队，拒绝少数文件系统中被替换成链接的 Dirent。
        const info = await io.fs.lstat(path).catch(() => null)
        if (info?.isDirectory() && !info.isSymbolicLink()) {
          queue.push({ path, depth: current.depth + 1 })
        }
      }
    }
  }
  return files
}

export function skillPathKey(path: string, io: WorkspaceIO = localWorkspaceIO): string {
  const key = workspacePathKey(io, path)
  return io.platform === 'win32' ? key.replaceAll('\\', '/') : key
}

async function validateRoot(
  absoluteRoot: string,
  diagnostics: SkillDiagnostic[],
  io: WorkspaceIO,
): Promise<boolean> {
  try {
    const rootInfo = await io.fs.lstat(absoluteRoot)
    if (rootInfo.isSymbolicLink()) {
      diagnostics.push({ path: absoluteRoot, message: 'Skill 根目录是符号链接，已跳过' })
      return false
    }
    if (!rootInfo.isDirectory()) {
      diagnostics.push({ path: absoluteRoot, message: 'Skill 根路径不是目录，已跳过' })
      return false
    }
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    diagnostics.push({
      path: absoluteRoot,
      message: `Skill 根目录检查失败：${error instanceof Error ? error.message : String(error)}`,
    })
    return false
  }
}

async function readDirectory(
  path: string,
  diagnostics: SkillDiagnostic[],
  io: WorkspaceIO,
): Promise<WorkspaceDirent[] | null> {
  try {
    return await io.fs.readdir(path, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) return null
    diagnostics.push({
      path,
      message: `目录读取失败：${error instanceof Error ? error.message : String(error)}`,
    })
    return null
  }
}

function directoriesBetween(root: string, leaf: string, io: WorkspaceIO): string[] {
  const result: string[] = []
  let current = leaf
  while (true) {
    result.push(current)
    if (skillPathKey(current, io) === skillPathKey(root, io)) return result.reverse()
    const parent = io.path.dirname(current)
    if (parent === current) return [leaf]
    current = parent
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR'),
  )
}
