import { localWorkspaceIO, workspacePathKey } from '../../workspace/io.ts'
import { PRESENT_TOOL_NAME, presentationSchema, type PresentedFile } from '../../presentation.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { buildTool } from '../tool.ts'
import { PRESENT_PROMPT } from './prompt.ts'

export const presentTool = buildTool({
  name: PRESENT_TOOL_NAME,
  description: '声明最终成品文件',
  prompt: PRESENT_PROMPT,
  inputSchema: presentationSchema,
  isReadOnly: true,
  kind: 'read',
  extractPaths: input => input.files.map(file => file.path),
  async execute(input, ctx) {
    const io = ctx.workspaceIO ?? localWorkspaceIO

    const files = new Map<string, PresentedFile>()
    for (const file of input.files) {
      ctx.abortSignal.throwIfAborted()
      const path = await resolveAllowed(ctx, file.path)
      if (!(await io.fs.lstat(path)).isFile()) throw new Error(`交付物须为已存在的普通文件：${file.path}`)
      const reader = await io.fs.open(path, 'r')
      await reader.close()
      files.set(workspacePathKey(io, path), { ...file, path })
    }
    ctx.abortSignal.throwIfAborted()
    const result = presentationSchema.parse({ files: [...files.values()] })
    return { data: JSON.stringify(result), isError: false }
  },
})
