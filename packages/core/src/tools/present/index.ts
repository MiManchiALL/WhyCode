import { access, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
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
    const files = new Map<string, PresentedFile>()
    for (const file of input.files) {
      ctx.abortSignal.throwIfAborted()
      const path = resolveAllowed(ctx, file.path)
      if (!(await lstat(path)).isFile()) throw new Error(`交付物须为已存在的普通文件：${file.path}`)
      await access(path, constants.R_OK)
      files.set(process.platform === 'win32' ? path.toLowerCase() : path, { ...file, path })
    }
    ctx.abortSignal.throwIfAborted()
    const result = presentationSchema.parse({ files: [...files.values()] })
    return { data: JSON.stringify(result), isError: false }
  },
})
