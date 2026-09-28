import { localWorkspaceIO } from '../../workspace/io.ts'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { makeDiff } from './diff.ts'
import { describeFileChange } from '../file-changes.ts'

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
  checkpointScope: async (input, ctx) => ({
    kind: 'exact-files',
    paths: [await resolveAllowed(ctx, input.path)],
  }),
  async renderDiff(input, ctx) {
    const { readFile } = (ctx.workspaceIO ?? localWorkspaceIO).fs

    const abs = await resolveAllowed(ctx, input.path)
    const old = await readFile(abs, 'utf8').catch(() => '')
    return makeDiff(input.path, old, input.content)
  },
  async execute(input, ctx) {
    const io = ctx.workspaceIO ?? localWorkspaceIO
    const { readFile, writeFile, mkdir } = io.fs
    const { dirname } = io.path

    const abs = await resolveAllowed(ctx, input.path)
    const old = await readFile(abs, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return ''
      throw error
    })
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf8')
    return {
      data: `已写入 ${input.path}`,
      isError: false,
      fileChanges: [describeFileChange(input.path, old, input.content)],
    }
  },
})
