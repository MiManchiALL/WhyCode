import { localWorkspaceIO, outsideWorkspaceBoundary, type WorkspaceIO } from '../workspace/io.ts'
import type { ToolContext } from './tool.ts'

/**
 * 工具侧的路径解析：限制在项目目录 + 会话 scratch + 已授权目录内。
 * 权限引擎在执行前已做过边界审批，这里是执行时的最后防线（越界抛错）。
 */
export async function resolveAllowed(ctx: ToolContext, inputPath: string): Promise<string> {
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const outside = await outsideWorkspaceBoundary(io, inputPath, ctx.projectDir, ctx.additionalDirs)
  if (outside) {
    throw new Error(`路径超出允许范围：${inputPath}`)
  }
  return io.path.resolve(ctx.projectDir, inputPath)
}

export function displayToolPath(projectDir: string, root: string, path: string, io: WorkspaceIO = localWorkspaceIO): string {
  const { resolve, relative, isAbsolute } = io.path
  const absolute = resolve(root, path.replace(/^\.\//, ''))
  const projectRelative = relative(projectDir, absolute)
  if (projectRelative && !projectRelative.startsWith('..') && !isAbsolute(projectRelative)) {
    return projectRelative.replaceAll('\\', '/')
  }
  return projectRelative ? absolute.replaceAll('\\', '/') : '.'
}

/** 目录遍历时跳过的项（避免扫进依赖和版本库） */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.pnpm-store',
  '.pnpm-cache',
  '.yarn',
  '.git',
  '.svn',
  '.hg',
  '.jj',
  '.sl',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.cache',
  '.pytest_cache',
  '__pycache__',
  '.venv',
  'venv',
  '.turbo',
])
