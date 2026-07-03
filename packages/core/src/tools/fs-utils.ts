import { resolve, relative, isAbsolute } from 'node:path'

/** 把工具传入的路径限制在项目目录内，越界抛错。返回解析后的绝对路径。 */
export function resolveInProject(projectDir: string, inputPath: string): string {
  const abs = isAbsolute(inputPath) ? inputPath : resolve(projectDir, inputPath)
  const rel = relative(projectDir, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`路径超出项目目录：${inputPath}`)
  }
  return abs
}

/** 目录遍历时跳过的项（避免扫进依赖和版本库） */
export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.cache'])
