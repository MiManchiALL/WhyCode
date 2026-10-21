import { localWorkspaceIO, workspacePathKey } from '../../workspace/io.ts'
import { z } from 'zod'
import { buildTool, type ToolContext } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { makeDiff } from '../write-edit/index.ts'
import { describeFileChange, type ToolFileChange } from '../file-changes.ts'
import { readFileTextPreview } from '../../checkpoints/file-history.ts'

export const DELETE_FILE_TOOL_NAME = 'DeleteFile'

const deleteFileInputSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(50)
    .describe('要删除的普通文件路径，最多 50 个'),
})

type DeleteFileInput = z.infer<typeof deleteFileInputSchema>

interface DeleteTarget {
  absolute: string
  displayPath: string
  change?: ToolFileChange
}

async function resolveDeleteTargets(input: DeleteFileInput, ctx: ToolContext): Promise<DeleteTarget[]> {
  const targets = new Map<string, DeleteTarget>()
  for (const displayPath of input.paths) {
    const absolute = await resolveAllowed(ctx, displayPath)
    const key = workspacePathKey(ctx.workspaceIO ?? localWorkspaceIO, absolute)
    if (!targets.has(key)) targets.set(key, { absolute, displayPath })
  }
  return [...targets.values()]
}

async function requireRegularFile(path: string, label: string, ctx: ToolContext): Promise<void> {
  const stats = await (ctx.workspaceIO ?? localWorkspaceIO).fs.lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!stats) throw new Error(`${label}不存在`)
  if (!stats.isFile()) throw new Error(`${label}不是普通文件；本工具不操作目录或符号链接`)
}

export const deleteFileTool = buildTool({
  name: DELETE_FILE_TOOL_NAME,
  description: '删除一个或多个文件',
  prompt:
    '删除允许范围内的一个或多个普通文件，并为本次调用建立可恢复的精确检查点。所有路径会在删除前完成校验。不要用 RunCommand 删除明确文件。本工具不会删除目录、符号链接或执行递归删除。',
  inputSchema: deleteFileInputSchema,
  isReadOnly: false,
  kind: 'edit',
  extractPaths: (input) => input.paths,
  checkpointScope: async (input, ctx) => ({
    kind: 'exact-files',
    paths: (await resolveDeleteTargets(input, ctx)).map((target) => target.absolute),
  }),
  async renderDiff(input, ctx) {
    const targets = await resolveDeleteTargets(input, ctx)
    const diffs: string[] = []
    for (const { absolute, displayPath } of targets) {
      const preview = await readFileTextPreview(absolute, ctx.workspaceIO)
      if (preview.kind === 'text') diffs.push(makeDiff(displayPath, preview.content, ''))
    }
    return diffs.filter(Boolean).join('\n\n')
  },
  async execute(input, ctx) {
    const io = ctx.workspaceIO ?? localWorkspaceIO
    const { unlink } = io.fs

    let targets: DeleteTarget[]
    try {
      targets = await resolveDeleteTargets(input, ctx)
      await Promise.all(
        targets.map(({ absolute, displayPath }) =>
          requireRegularFile(absolute, `文件 ${displayPath}`, ctx),
        ),
      )
      for (const target of targets) {
        const preview = await readFileTextPreview(target.absolute, io)
        if (preview.kind === 'text') target.change = describeFileChange(target.displayPath, preview.content, '')
      }
    } catch (error) {
      return {
        data: `删除未执行：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }

    let deleted = 0
    const fileChanges: ToolFileChange[] = []
    try {
      for (const target of targets) {
        await unlink(target.absolute)
        deleted++
        if (target.change) fileChanges.push(target.change)
      }
    } catch (error) {
      return {
        data:
          `删除中断：${error instanceof Error ? error.message : String(error)}` +
          `；已删除 ${deleted}/${targets.length} 个文件，可使用检查点回滚`,
        isError: true,
        ...(fileChanges.length ? { fileChanges } : {}),
      }
    }

    return {
      data: targets.length === 1
        ? `已删除 ${targets[0]!.displayPath}`
        : `已删除 ${targets.length} 个文件`,
      isError: false,
      fileChanges,
    }
  },
})
