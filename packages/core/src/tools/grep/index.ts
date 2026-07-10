import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveAllowed, IGNORED_DIRS } from '../fs-utils.ts'
import { collectFiles, globToRegExp } from '../search/fallback.ts'
import { runRipgrepLines } from '../search/ripgrep.ts'

export const GREP_TOOL_NAME = 'Grep'

const DEFAULT_LIMIT = 100
const MAX_FILE_BYTES = 2 * 1024 * 1024
const READ_BATCH_SIZE = 16

type OutputMode = 'content' | 'files_with_matches' | 'count'

function looksBinary(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, 512)
  for (let index = 0; index < length; index++) {
    if (buffer[index] === 0) return true
  }
  return false
}

function exclusionArgs(): string[] {
  return [...IGNORED_DIRS].flatMap((dir) => ['--glob', `!${dir}/**`])
}

function outputPath(projectDir: string, root: string, path: string): string {
  const absolute = resolve(root, path.replace(/^\.\//, ''))
  const projectRelative = relative(projectDir, absolute)
  if (projectRelative && !projectRelative.startsWith('..') && !isAbsolute(projectRelative)) {
    return projectRelative.replaceAll('\\', '/')
  }
  if (!projectRelative) return '.'
  return absolute.replaceAll('\\', '/')
}

function normalizeRipgrepLine(
  line: string,
  mode: OutputMode,
  projectDir: string,
  root: string,
): string {
  if (line === '--') return line
  if (mode === 'files_with_matches') return outputPath(projectDir, root, line)
  if (mode === 'content') {
    const first = line.indexOf('\t')
    const second = first === -1 ? -1 : line.indexOf('\t', first + 1)
    if (first === -1 || second === -1) return line
    const path = line.slice(0, first)
    const lineNumber = line.slice(first + 1, second)
    return `${outputPath(projectDir, root, path)}:${lineNumber}:${line.slice(second + 1)}`
  }
  const match = line.match(/^(.*):(\d+)$/)
  if (!match) return line
  return `${outputPath(projectDir, root, match[1]!)}:${match[2]}`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function fallbackSearch(options: {
  root: string
  onlyFile?: string
  projectDir: string
  pattern: string
  include?: string
  mode: OutputMode
  caseSensitive: boolean
  literal: boolean
  context: number
  signal: AbortSignal
  resultLimit: number
}): Promise<{ lines: string[]; truncated: boolean }> {
  const collected = options.onlyFile
    ? { files: [options.onlyFile], truncated: false }
    : await collectFiles(options.root, options.signal)
  const includeMatcher = options.include ? globToRegExp(options.include) : null
  const expression = new RegExp(
    options.literal ? escapeRegExp(options.pattern) : options.pattern,
    options.caseSensitive ? '' : 'i',
  )
  const results: string[] = []

  for (let start = 0; start < collected.files.length; start += READ_BATCH_SIZE) {
    if (options.signal.aborted) {
      const error = new Error('搜索已被中止')
      error.name = 'AbortError'
      throw error
    }
    const batch = collected.files.slice(start, start + READ_BATCH_SIZE)
    const contents = await Promise.all(
      batch.map(async (path) => ({ path, buffer: await readFile(path).catch(() => null) })),
    )
    for (const { path, buffer } of contents) {
      if (!buffer || buffer.length > MAX_FILE_BYTES || looksBinary(buffer)) continue
      const rootRelative = relative(options.root, path).replaceAll('\\', '/')
      if (
        includeMatcher &&
        !includeMatcher.test(rootRelative) &&
        !includeMatcher.test(basename(rootRelative))
      ) {
        continue
      }
      const lines = buffer.toString('utf8').split('\n')
      const matchingLines: number[] = []
      for (let index = 0; index < lines.length; index++) {
        if (expression.test(lines[index]!)) matchingLines.push(index)
      }
      if (matchingLines.length === 0) continue

      const display = outputPath(options.projectDir, options.root, rootRelative)
      if (options.mode === 'files_with_matches') {
        results.push(display)
      } else if (options.mode === 'count') {
        results.push(`${display}:${matchingLines.length}`)
      } else {
        for (const matchIndex of matchingLines) {
          const from = Math.max(0, matchIndex - options.context)
          const to = Math.min(lines.length - 1, matchIndex + options.context)
          for (let index = from; index <= to; index++) {
            const marker = index === matchIndex ? ':' : '-'
            results.push(`${display}${marker}${index + 1}${marker}${lines[index]!.slice(0, 500)}`)
            if (results.length >= options.resultLimit) break
          }
          if (results.length >= options.resultLimit) break
          if (options.context > 0) results.push('--')
        }
      }
      if (results.length >= options.resultLimit) break
    }
    if (results.length >= options.resultLimit) break
  }

  return {
    lines: results.slice(0, options.resultLimit),
    truncated: collected.truncated || results.length >= options.resultLimit,
  }
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
    const requestedPath = resolveAllowed(ctx, input.path ?? '.')
    const pathStats = await stat(requestedPath)
    if (!pathStats.isDirectory() && !pathStats.isFile()) {
      return { data: `搜索失败：${input.path ?? '.'} 不是普通文件或目录`, isError: true }
    }
    const root = pathStats.isDirectory() ? requestedPath : dirname(requestedPath)
    const target = pathStats.isDirectory() ? '.' : basename(requestedPath)
    const mode = input.outputMode ?? 'content'
    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_LIMIT
    const requested = offset + limit + 1
    const args = ['--hidden', '--color', 'never', '--max-columns', '500', ...exclusionArgs()]
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
    args.push('--regexp', input.pattern, target)

    const rg = await runRipgrepLines(args, root, ctx.abortSignal, requested)
    const searched = rg
      ? {
          lines: rg.lines.map((line) =>
            normalizeRipgrepLine(line, mode, ctx.projectDir, root),
          ),
          truncated: rg.truncated,
        }
      : await fallbackSearch({
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
  },
})
