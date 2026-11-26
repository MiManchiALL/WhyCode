import { z } from 'zod'
import { localWorkspaceIO } from '../../workspace/io.ts'
import { buildTool } from '../tool.ts'
import { displayToolPath, resolveAllowed, rethrowTargetError } from '../fs-utils.ts'
import { fallbackGrep } from '../search/fallback-grep.ts'
import { fileGlob, gitignoreSchema } from '../search/file-filters.ts'
import { ripgrepFileArgs, runRipgrepLines } from '../search/ripgrep.ts'
import { withSearchDeadline } from '../search/deadline.ts'
import { SearchPage } from '../search/page.ts'

export const GREP_TOOL_NAME = 'Grep'
const GREP_PAGE_SIZE = 250

export const grepTool = buildTool({
  name: GREP_TOOL_NAME,
  description: '按正则表达式搜索文件内容',
  prompt:
    '使用 ripgrep 的默认正则语法（Rust regex），在文件或目录中逐行搜索文本。默认按文件列出匹配行及行号，也可只列出匹配文件的路径，或统计每个文件的匹配行数。有更多结果时，末尾给出下一页的 `offset`。',
  inputSchema: z.strictObject({
    pattern: z.string().min(1).describe('匹配文件内容的正则表达式'),
    path: z.string().optional().describe('搜索文件或目录，默认项目根目录'),
    include: z.string().optional().describe(
      '使用与 Glob.pattern 相同的 glob 规则筛选文件，例如 src/**/*.{ts,tsx}。目录搜索以 path（默认项目根目录）为基准，只筛选 gitignore 设置允许搜索的文件。显式指定单个文件时，按文件名匹配。',
    ),
    outputMode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe('content 返回匹配行（默认），files_with_matches 返回文件路径，count 返回每个文件的匹配行数'),
    caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 true'),
    gitignore: gitignoreSchema,
    offset: z.number().int().min(0).optional().describe('跳过的结果数，默认 0。content 按匹配行计，files_with_matches 和 count 按文件计。'),
  }),
  isReadOnly: true,
  kind: 'read',
  extractPaths: (input) => (input.path ? [input.path] : []),
  async execute(input, ctx) {
    return withSearchDeadline(ctx, async ctx => {
      const io = ctx.workspaceIO ?? localWorkspaceIO
      const path = await resolveAllowed(ctx, input.path ?? '.')
      ctx.abortSignal.throwIfAborted()
      const stats = await io.fs.stat(path).catch(error => rethrowTargetError(error, '搜索路径'))
      ctx.abortSignal.throwIfAborted()
      if (!stats.isDirectory() && !stats.isFile()) {
        return { data: `搜索失败：${input.path ?? '.'} 不是普通文件或目录`, isError: true }
      }
      const root = stats.isDirectory() ? path : io.path.dirname(path)
      const target = stats.isDirectory() ? '.' : io.path.basename(path)
      const mode = input.outputMode ?? 'content'
      const page = new SearchPage(input.offset ?? 0, GREP_PAGE_SIZE)
      const gitignore = input.gitignore ?? true
      const include = input.include ? fileGlob(input.include) : undefined
      const args = [...ripgrepFileArgs(gitignore, include?.pattern), '--color', 'never', '--with-filename']
      if (mode === 'content') {
        args.push('--null', '--line-number', '--no-heading', '--max-columns', '500', '--max-columns-preview')
      } else if (mode === 'count') args.push('--null', '--count')
      else args.push('--files-with-matches')
      if (input.caseSensitive === false) args.push('--ignore-case')
      args.push('--regexp', input.pattern, '--', target)

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
      return fallbackGrep({ root, onlyFile: stats.isFile() ? path : undefined, include, gitignore }, {
        pattern: input.pattern, mode, caseSensitive: input.caseSensitive ?? true,
      }, page, ctx)
    })
  },
})
