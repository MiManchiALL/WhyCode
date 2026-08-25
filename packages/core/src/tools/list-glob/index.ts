import { readdir } from 'node:fs/promises'
import { relative } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { displayToolPath, resolveAllowed, IGNORED_DIRS } from '../fs-utils.ts'
import { collectFiles, globToRegExp } from '../search/fallback.ts'
import { runRipgrepLines } from '../search/ripgrep.ts'

export const LIST_DIR_TOOL_NAME = 'ListDir'
export const GLOB_TOOL_NAME = 'Glob'

const DEFAULT_LIST_LIMIT = 500
const DEFAULT_GLOB_LIMIT = 200

export const listDirTool = buildTool({
  name: LIST_DIR_TOOL_NAME,
  description: '列出目录内容',
  prompt:
    '列出允许范围内某个目录的文件与子目录（目录名以 / 结尾），不递归。结果支持 limit/offset 分页；需要递归查找时使用 Glob。',
  inputSchema: z.object({
    path: z.string().describe('目录路径；"." 表示项目根目录'),
    limit: z.number().int().min(1).max(2_000).optional().describe('返回条数，默认 500'),
    offset: z.number().int().min(0).optional().describe('跳过条数，默认 0'),
  }),
  isReadOnly: true,
  kind: 'read',
  extractPaths: (input) => [input.path],
  async execute(input, ctx) {
    const abs = resolveAllowed(ctx, input.path)
    const entries = await readdir(abs, { withFileTypes: true })
    const all = entries
      .filter((entry) => !IGNORED_DIRS.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b))
    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_LIST_LIMIT
    const shown = all.slice(offset, offset + limit)
    const truncated = offset + limit < all.length
    const note = truncated
      ? `\n[共 ${all.length} 项，当前显示 ${offset + 1}-${offset + shown.length}；用 offset=${offset + shown.length} 继续]`
      : ''
    return { data: shown.join('\n') + note || '（空目录）', isError: false }
  },
})

function exclusionArgs(): string[] {
  return [...IGNORED_DIRS].flatMap((dir) => ['--glob', `!${dir}/**`])
}

export const globTool = buildTool({
  name: GLOB_TOOL_NAME,
  description: '按模式快速查找文件名',
  prompt:
    '在允许范围内按 glob 模式查找文件，例如 "src/**/*.ts"、"*.json"、"*.{ts,tsx}"。可用 path 缩小搜索根目录，并用 limit/offset 分页。优先使用高性能 ripgrep，环境没有 rg 时自动回退。',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('glob 模式，支持 *、**、? 和 {a,b}'),
    path: z.string().optional().describe('搜索根目录，默认项目根目录'),
    limit: z.number().int().min(1).max(1_000).optional().describe('返回条数，默认 200'),
    offset: z.number().int().min(0).optional().describe('跳过条数，默认 0'),
  }),
  isReadOnly: true,
  kind: 'read',
  extractPaths: (input) => (input.path ? [input.path] : []),
  async execute(input, ctx) {
    const root = resolveAllowed(ctx, input.path ?? '.')
    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_GLOB_LIMIT
    const requested = offset + limit + 1
    const rg = await runRipgrepLines(
      ['--files', '--hidden', '--no-ignore', ...exclusionArgs(), '--glob', input.pattern, '.'],
      root,
      ctx.abortSignal,
      requested,
    )

    let matches: string[]
    let scanTruncated = false
    if (rg) {
      matches = rg.lines.map((path) => displayToolPath(ctx.projectDir, root, path))
      scanTruncated = rg.truncated
    } else {
      const collected = await collectFiles(root, ctx.abortSignal)
      const matcher = globToRegExp(input.pattern.replaceAll('\\', '/'))
      matches = collected.files
        .map((path) => ({
          relative: relative(root, path).replaceAll('\\', '/'),
          display: displayToolPath(ctx.projectDir, root, relative(root, path)),
        }))
        .filter(({ relative: path }) => matcher.test(path))
        .map(({ display }) => display)
        .sort((a, b) => a.localeCompare(b))
      scanTruncated = collected.truncated
    }

    const hasMore = scanTruncated || matches.length > offset + limit
    const shown = matches.slice(offset, offset + limit)
    const note = hasMore
      ? `\n[结果已截断；用更具体的 pattern/path，或 offset=${offset + shown.length} 继续]`
      : ''
    return { data: shown.join('\n') + note || '（无匹配文件）', isError: false }
  },
})
