import { Minimatch } from 'minimatch'
import { z } from 'zod'

export const SEARCH_EXCLUDED_DIRS: readonly string[] = ['.git', 'node_modules']

export const gitignoreSchema = z.boolean().optional().describe(
  '是否遵循忽略规则，默认 true。设为 false 可搜索被 .gitignore、.ignore、.rgignore 或 Git 排除规则忽略的文件。'
  + `两种设置在递归遍历时都会跳过遇到的 ${SEARCH_EXCLUDED_DIRS.join(' 和 ')} 目录。`,
)

export function fileGlob(pattern: string): Minimatch {
  const path = pattern.replaceAll('\\', '/')
  return new Minimatch(path.replace(/^(?:\.\/|\/)/, ''), {
    platform: 'linux', dot: true, matchBase: !path.includes('/'), noext: true, nonegate: true, nocomment: true,
    braceExpandMax: 1_000,
  })
}
