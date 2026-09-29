import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { displayToolPath, resolveAllowed } from '../fs-utils.ts'
import { fallbackGrep, type GrepOutputMode } from '../search/fallback-grep.ts'
import { runRipgrepLines, SEARCH_EXCLUSIONS } from '../search/ripgrep.ts'
import { withSearchDeadline } from '../search/deadline.ts'

export const GREP_TOOL_NAME = 'Grep'

const DEFAULT_LIMIT = 100

function normalizeRipgrepLine(
  line: string,
  mode: GrepOutputMode,
  projectDir: string,
  root: string,
  io: WorkspaceIO,
): string {
  if (line === '--') return line
  if (mode === 'files_with_matches') return displayToolPath(projectDir, root, line, io)
  if (mode === 'content') {
    const first = line.indexOf('\t')
    const second = first === -1 ? -1 : line.indexOf('\t', first + 1)
    if (first === -1 || second === -1) return line
    const path = line.slice(0, first)
    const lineNumber = line.slice(first + 1, second)
    return `${displayToolPath(projectDir, root, path, io)}:${lineNumber}:${line.slice(second + 1)}`
  }
  const match = line.match(/^(.*):(\d+)$/)
  if (!match) return line
  return `${displayToolPath(projectDir, root, match[1]!, io)}:${match[2]}`
}

export const grepTool = buildTool({
  name: GREP_TOOL_NAME,
  description: '使用正则或纯文本快速搜索文件内容',
  prompt:
    '在允许范围内搜索文件内容。默认返回“路径:行号:内容”；可切换为 files_with_matches 或 count，支持 include、大小写、纯文本、上下文和 limit/offset。优先使用 ripgrep 并尊重 ignore 文件，环境没有 rg 时自动使用有界并发回退。结果过多时应缩小 pattern/include/path 或分页。',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('正则表达式；literal=true 时按普通文本匹配'),
    include: z.string().optional().describe('文件 glob，例如 "*.ts"、"src/**/*.{ts,tsx}"'),
    path: z.string().optional().describe('搜索文件或目录，默认项目根目录'),
    outputMode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe('输出模式，默认 content'),
    caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 true'),
    literal: z.boolean().optional().describe('按普通文本而非正则匹配，默认 false'),
    context: z.number().int().min(0).max(20).optional().describe('匹配前后各显示多少行，仅 content 有效'),
    limit: z.number().int().min(1).max(1_000).optional().describe('返回行/条目数，默认 100'),
    offset: z.number().int().min(0).optional().describe('跳过结果数，默认 0'),
  }),
  isReadOnly: true,
  kind: 'read',
  extractPaths: (input) => (input.path ? [input.path] : []),
  async execute(input, ctx) {
    return withSearchDeadline(ctx, async ctx => {
      const io = ctx.workspaceIO ?? localWorkspaceIO
      const { stat } = io.fs
      const { dirname, basename } = io.path

      const requestedPath = await resolveAllowed(ctx, input.path ?? '.')
      ctx.abortSignal.throwIfAborted()
      const pathStats = await stat(requestedPath)
      ctx.abortSignal.throwIfAborted()
      if (!pathStats.isDirectory() && !pathStats.isFile()) {
        return { data: `搜索失败：${input.path ?? '.'} 不是普通文件或目录`, isError: true }
      }
      const root = pathStats.isDirectory() ? requestedPath : dirname(requestedPath)
      const target = pathStats.isDirectory() ? '.' : basename(requestedPath)
      const mode = input.outputMode ?? 'content'
      const offset = input.offset ?? 0
      const limit = input.limit ?? DEFAULT_LIMIT
      const requested = offset + limit + 1
      const args = ['--hidden', '--sort', 'path', '--color', 'never', '--max-columns', '500', '--with-filename']
      if (mode === 'content') {
        args.push(
          '--line-number',
          '--no-heading',
          '--field-match-separator',
          '\t',
          '--field-context-separator',
          '\t',
        )
        if ((input.context ?? 0) > 0) args.push('--context', String(input.context))
      } else if (mode === 'files_with_matches') {
        args.push('--files-with-matches')
      } else {
        args.push('--count')
      }
      if (input.caseSensitive === false) args.push('--ignore-case')
      if (input.literal) args.push('--fixed-strings')
      if (input.include) args.push('--glob', input.include)
      args.push(...SEARCH_EXCLUSIONS, '--regexp', input.pattern, '--', target)

      const rg = await runRipgrepLines(args, root, ctx.abortSignal, requested, io)
      const searched = rg
        ? {
            lines: rg.lines.map((line) =>
              normalizeRipgrepLine(line, mode, ctx.projectDir, root, io),
            ),
            truncated: rg.truncated,
          }
        : await fallbackGrep({
            io,
            root,
            onlyFile: pathStats.isFile() ? requestedPath : undefined,
            projectDir: ctx.projectDir,
            pattern: input.pattern,
            include: input.include,
            mode,
            caseSensitive: input.caseSensitive ?? true,
            literal: input.literal ?? false,
            context: input.context ?? 0,
            signal: ctx.abortSignal,
            resultLimit: requested,
          })

      const hasMore = searched.truncated || searched.lines.length > offset + limit
      const shown = searched.lines.slice(offset, offset + limit)
      const note = hasMore
        ? `\n[结果已截断；请缩小搜索范围，或用 offset=${offset + shown.length} 继续]`
        : ''
      return { data: shown.join('\n') + note || '（无匹配）', isError: false }
    })
  },
})
