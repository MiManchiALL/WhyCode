import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { buildTool, type ToolContext } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { makeDiff } from '../write-edit/index.ts'

export const DELETE_FILE_TOOL_NAME = 'DeleteFile'
export const MOVE_FILE_TOOL_NAME = 'MoveFile'

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
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function resolveDeleteTargets(input: DeleteFileInput, ctx: ToolContext): DeleteTarget[] {
  const targets = new Map<string, DeleteTarget>()
  for (const displayPath of input.paths) {
    const absolute = resolveAllowed(ctx, displayPath)
    const key = pathKey(absolute)
    if (!targets.has(key)) targets.set(key, { absolute, displayPath })
  }
  return [...targets.values()]
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path).catch(() => null)
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
  checkpointScope: (input, ctx) => ({
    kind: 'exact-files',
    paths: resolveDeleteTargets(input, ctx).map((target) => target.absolute),
  }),
  async renderDiff(input, ctx) {
    const targets = resolveDeleteTargets(input, ctx)
    return (await Promise.all(
      targets.map(async ({ absolute, displayPath }) =>
        makeDiff(displayPath, await readFile(absolute, 'utf8'), ''),
      ),
    )).filter(Boolean).join('\n\n')
  },
  async execute(input, ctx) {
    let targets: DeleteTarget[]
    try {
      targets = resolveDeleteTargets(input, ctx)
      await Promise.all(
        targets.map(({ absolute, displayPath }) =>
          requireRegularFile(absolute, `文件 ${displayPath}`),
        ),
      )
    } catch (error) {
      return {
        data: `删除未执行：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }

    let deleted = 0
    try {
      for (const target of targets) {
        await unlink(target.absolute)
        deleted++
      }
    } catch (error) {
      return {
        data:
          `删除中断：${error instanceof Error ? error.message : String(error)}` +
          `；已删除 ${deleted}/${targets.length} 个文件，可使用检查点回滚`,
        isError: true,
      }
    }

    return {
      data: targets.length === 1
        ? `已删除 ${targets[0]!.displayPath}`
        : `已删除 ${targets.length} 个文件`,
      isError: false,
    }
  },
})

export const moveFileTool = buildTool({
  name: MOVE_FILE_TOOL_NAME,
  description: '移动或重命名单个文件',
  prompt:
    '移动或重命名允许范围内的单个普通文件，并对源文件和目标文件建立精确检查点。目标必须不存在，避免静默覆盖；如确实需要替换，先显式处理目标文件。不要用 RunCommand 绕过文件授权。',
  inputSchema: z.object({
    source: z.string().describe('现有源文件路径'),
    destination: z.string().describe('尚不存在的目标文件路径'),
  }),
  isReadOnly: false,
  kind: 'edit',
  extractPaths: (input) => [input.source, input.destination],
  checkpointScope: (input, ctx) => ({
    kind: 'exact-files',
    paths: [
      resolveAllowed(ctx, input.source),
      resolveAllowed(ctx, input.destination),
    ],
  }),
  async renderDiff(input, ctx) {
    const source = resolveAllowed(ctx, input.source)
    const content = await readFile(source, 'utf8')
    return [
      makeDiff(input.source, content, ''),
      makeDiff(input.destination, '', content),
    ].join('\n\n')
  },
  async execute(input, ctx) {
    const source = resolveAllowed(ctx, input.source)
    const destination = resolveAllowed(ctx, input.destination)
    try {
      await requireRegularFile(source, `源文件 ${input.source}`)
      if (await lstat(destination).catch(() => null)) {
        return { data: `移动失败：目标 ${input.destination} 已存在`, isError: true }
      }
      await mkdir(dirname(destination), { recursive: true })
      try {
        await rename(source, destination)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
        await copyFile(source, destination, constants.COPYFILE_EXCL)
        try {
          await unlink(source)
        } catch (unlinkError) {
          await rm(destination, { force: true }).catch(() => undefined)
          throw unlinkError
        }
      }
      return { data: `已移动 ${input.source} → ${input.destination}`, isError: false }
    } catch (error) {
      return {
        data: `移动失败：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  },
})
