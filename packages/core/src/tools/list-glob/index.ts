import { localWorkspaceIO } from '../../workspace/io.ts'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { displayToolPath, resolveAllowed, rethrowTargetError } from '../fs-utils.ts'
import { fallbackGlob } from '../search/fallback-glob.ts'
import { fileGlob, gitignoreSchema } from '../search/file-filters.ts'
import { ripgrepFileArgs, runRipgrepLines } from '../search/ripgrep.ts'
import { withSearchDeadline } from '../search/deadline.ts'
import { SearchPage } from '../search/page.ts'
import { formatGlobPaths } from './format-paths.ts'

export const LIST_DIR_TOOL_NAME = 'ListDir'
export const GLOB_TOOL_NAME = 'Glob'

const DEFAULT_LIST_LIMIT = 500
const GLOB_PAGE_SIZE = 200
const LIST_DIR_EXCLUSIONS = new Set([
  'node_modules', '.pnpm-store', '.pnpm-cache', '.yarn',
  '.git', '.svn', '.hg', '.jj', '.sl',
  'dist', 'out', 'build', 'coverage', '.next',
  '.cache', '.pytest_cache', '__pycache__', '.venv', 'venv', '.turbo',
])

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
    const io = ctx.workspaceIO ?? localWorkspaceIO
    const { readdir } = io.fs

    const abs = await resolveAllowed(ctx, input.path)
    const entries = await readdir(abs, { withFileTypes: true })
    const all = entries
      .filter((entry) => !LIST_DIR_EXCLUSIONS.has(entry.name))
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((a, b) => a.localeCompare(b))
    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_LIST_LIMIT
    const shown = all.slice(offset, offset + limit)
    const truncated = offset + limit < all.length
    const note = truncated
      ? `\n[共 ${all.length} 项，当前显示 ${offset + 1}-${offset + shown.length}；用 offset=${offset + shown.length} 继续]`
      : ''
    return { data: shown.join('\n') + note || (all.length ? `（已到目录末尾，共 ${all.length} 项）` : '（空目录）'), isError: false }
  },
})

export const globTool = buildTool({
  name: GLOB_TOOL_NAME,
  description: '按 glob 模式递归查找文件',
  prompt:
    '在指定目录下递归查找路径符合 glob 模式的文件，按文件修改时间从新到旧排序。'
    + `剩余匹配文件超过 ${GLOB_PAGE_SIZE} 个或本页内容过长时，末尾给出下一页的 \`offset\`。`,
  inputSchema: z.strictObject({
    pattern: z.string().min(1).describe(
      '相对于搜索目录的 glob 模式，支持 *、**、? 和 {a,b}。*.ts 匹配任意层级的 .ts 文件，src/*.ts 只匹配 src 本层，src/**/*.ts 匹配 src 本层及子目录中的 .ts 文件。',
    ),
    path: z.string().optional().describe('搜索根目录，默认项目根目录'),
    gitignore: gitignoreSchema,
    offset: z.number().int().min(0).optional().describe('跳过的匹配文件数，默认 0'),
  }),
  isReadOnly: true,
  kind: 'read',
  extractPaths: (input) => (input.path ? [input.path] : []),
  async execute(input, ctx) {
    return withSearchDeadline(ctx, async ctx => {
      const io = ctx.workspaceIO ?? localWorkspaceIO
      const root = await resolveAllowed(ctx, input.path ?? '.')
      ctx.abortSignal.throwIfAborted()
      const stats = await io.fs.stat(root).catch(error => rethrowTargetError(error, '搜索路径'))
      if (!stats.isDirectory()) return { data: '搜索路径应为目录', isError: true }
      const page = new SearchPage(input.offset ?? 0, GLOB_PAGE_SIZE)
      const gitignore = input.gitignore ?? true
      const matcher = fileGlob(input.pattern)
      const args = ['--files', '--sortr', 'modified', ...ripgrepFileArgs(gitignore, matcher.pattern), '--', '.']
      const native = await runRipgrepLines(args, root, ctx.abortSignal, relativePath => {
        const path = relativePath.replaceAll('\\', '/').replace(/^\.\//, '')
        return !matcher.match(path) || page.add(displayToolPath(ctx.projectDir, root, path, io))
      }, io)
      const incomplete = native ? undefined : await fallbackGlob(root, matcher, gitignore, page, ctx)
      return page.result('（无匹配文件）', incomplete, formatGlobPaths)
    })
  },
})
