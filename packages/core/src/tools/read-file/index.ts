import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveInProject } from '../fs-utils.ts'

export const READ_FILE_TOOL_NAME = 'ReadFile'

const MAX_LINES = 1000

export const readFileTool = buildTool({
  name: READ_FILE_TOOL_NAME,
  description: '读取文件内容',
  prompt:
    '读取项目内的文件。返回带行号的内容（cat -n 格式）。默认最多返回前 1000 行，可用 offset/limit 读取更大文件的其它部分。',
  inputSchema: z.object({
    path: z.string().describe('文件路径（相对项目根目录或绝对路径，必须在项目内）'),
    offset: z.number().int().min(1).optional().describe('起始行号（从 1 开始）'),
    limit: z.number().int().min(1).optional().describe('最多读取的行数'),
  }),
  isReadOnly: true,
  needsApproval: () => false,
  async execute(input, ctx) {
    const abs = resolveInProject(ctx.projectDir, input.path)
    const content = await readFile(abs, 'utf-8')
    const lines = content.split('\n')
    const start = (input.offset ?? 1) - 1
    const count = Math.min(input.limit ?? MAX_LINES, MAX_LINES)
    const slice = lines.slice(start, start + count)
    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(5)}\t${line}`)
      .join('\n')
    const truncated =
      start + count < lines.length
        ? `\n[共 ${lines.length} 行，已截断，可用 offset=${start + count + 1} 继续读取]`
        : ''
    return { data: numbered + truncated, isError: false }
  },
})
