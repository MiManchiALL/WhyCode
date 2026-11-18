import { z } from 'zod'
import { localWorkspaceIO } from '../../workspace/io.ts'
import { buildTool } from '../tool.ts'
import { displayToolPath, resolveAllowed } from '../fs-utils.ts'
import { fallbackGrep } from '../search/fallback-grep.ts'
import { fileGlob } from '../search/fallback.ts'
import { runRipgrepLines, SEARCH_EXCLUSIONS } from '../search/ripgrep.ts'
import { withSearchDeadline } from '../search/deadline.ts'
import { SearchPage } from '../search/page.ts'

export const GREP_TOOL_NAME = 'Grep'

export const grepTool = buildTool({
  name: GREP_TOOL_NAME,
  description: '使用正则或纯文本快速搜索文件内容',
  prompt:
    '搜索文件内容。目录搜索遵循项目 ignore 规则，include 进一步限定文件。连续命中同一文件时只列一次路径，行号后的 : 表示匹配，- 表示上下文。只需路径或数量时用 files_with_matches 或 count。',
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
      const path = await resolveAllowed(ctx, input.path ?? '.')
      ctx.abortSignal.throwIfAborted()
      const stats = await io.fs.stat(path)
      ctx.abortSignal.throwIfAborted()
      if (!stats.isDirectory() && !stats.isFile()) {
        return { data: `搜索失败：${input.path ?? '.'} 不是普通文件或目录`, isError: true }
      }
      const root = stats.isDirectory() ? path : io.path.dirname(path)
      const target = stats.isDirectory() ? '.' : io.path.basename(path)
      const mode = input.outputMode ?? 'content'
      const page = new SearchPage(input.offset ?? 0, input.limit ?? 100)
      const include = input.include ? fileGlob(input.include) : undefined
      const args = ['--hidden', '--no-require-git', '--sort', 'path', '--color', 'never', '--with-filename']
      if (mode === 'content') {
        args.push('--null', '--line-number', '--no-heading', '--no-context-separator', '--max-columns', '500', '--max-columns-preview')
        if (input.context) args.push('--context', String(input.context))
      } else if (mode === 'count') args.push('--null', '--count')
      else args.push('--files-with-matches')
      if (input.caseSensitive === false) args.push('--ignore-case')
      if (input.literal) args.push('--fixed-strings')
      // 文件类型筛选保留 ignore 优先级。含目录的 glob 还需检查相对路径。
      if (include) {
        const split = include.pattern.lastIndexOf('/') + 1
        const leaf = include.pattern.slice(split)
        if (leaf && !/[[{]/.test(include.pattern.slice(0, split))) {
          args.push('--type-add', `whycode:${leaf}`, '--type', 'whycode')
        }
      }
      args.push(...SEARCH_EXCLUSIONS, '--regexp', input.pattern, '--', target)

      let lastPath: string | undefined
      let displayPath = ''
      const native = await runRipgrepLines(args, root, ctx.abortSignal, line => {
        const end = mode === 'files_with_matches' ? line.length : line.indexOf('\0')
        if (end < 0) throw new Error('搜索结果缺少路径分隔符')
        const rawPath = line.slice(0, end)
        if (lastPath !== rawPath) {
          lastPath = rawPath
          const relative = rawPath.replaceAll('\\', '/').replace(/^\.\//, '')
          displayPath = !include || include.match(relative) ? displayToolPath(ctx.projectDir, root, rawPath, io) : ''
        }
        if (!displayPath) return true
        if (mode === 'files_with_matches') return page.add(displayPath)
        const value = line.slice(end + 1)
        return page.add(mode === 'count' ? `${displayPath}:${value}` : { path: displayPath, line: value })
      }, io)
      if (native) return page.result('（无匹配）')
      return fallbackGrep({ root, onlyFile: stats.isFile() ? path : undefined, include }, {
        pattern: input.pattern, mode, caseSensitive: input.caseSensitive ?? true, literal: input.literal ?? false, context: input.context ?? 0,
      }, page, ctx)
    })
  },
})
