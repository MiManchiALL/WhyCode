import { resolve, isAbsolute } from 'node:path'
import { findOutsideBoundary } from '../permissions/path-safety.ts'
import type { ToolContext } from './tool.ts'

/**
 * 工具侧的路径解析：限制在项目目录 + 会话 scratch + 已授权目录内。
 * 权限引擎在执行前已做过边界审批，这里是执行时的最后防线（越界抛错）。
 */
export function resolveAllowed(ctx: ToolContext, inputPath: string): string {
  const outside = findOutsideBoundary(inputPath, ctx.projectDir, [...ctx.additionalDirs])
  if (outside) {
    throw new Error(`路径超出允许范围：${inputPath}`)
  }
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(ctx.projectDir, inputPath)
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
