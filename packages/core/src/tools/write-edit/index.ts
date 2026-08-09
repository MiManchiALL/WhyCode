import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { makeDiff } from './diff.ts'

export const WRITE_FILE_TOOL_NAME = 'WriteFile'

export { editFileTool, EDIT_FILE_TOOL_NAME } from './edit-file.ts'
export { makeDiff } from './diff.ts'

export const writeFileTool = buildTool({
  name: WRITE_FILE_TOOL_NAME,
  description: '写入/创建文件',
  prompt:
    '将完整内容写入允许范围内的文件（项目路径或经用户授权的外部路径；覆盖已有内容，自动创建父目录）。只适合新文件或整文件重写；修改已有文件优先用 EditFile。',
  inputSchema: z.object({
    path: z.string().describe('文件路径'),
    content: z.string().describe('完整文件内容'),
  }),
  isReadOnly: false,
  kind: 'edit',
  extractPaths: (input) => [input.path],
  checkpointScope: (input, ctx) => ({
    kind: 'exact-files',
    paths: [resolveAllowed(ctx, input.path)],
  }),
  async renderDiff(input, ctx) {
    const abs = resolveAllowed(ctx, input.path)
    const old = await readFile(abs, 'utf-8').catch(() => '')
    return makeDiff(input.path, old, input.content)
  },
  async execute(input, ctx) {
    const abs = resolveAllowed(ctx, input.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf-8')
    return { data: `已写入 ${input.path}`, isError: false }
  },
})
