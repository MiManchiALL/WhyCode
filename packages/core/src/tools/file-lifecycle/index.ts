import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { makeDiff } from '../write-edit/index.ts'

export const DELETE_FILE_TOOL_NAME = 'DeleteFile'
export const MOVE_FILE_TOOL_NAME = 'MoveFile'

async function requireRegularFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path).catch(() => null)
  if (!stats) throw new Error(`${label}不存在`)
  if (!stats.isFile()) throw new Error(`${label}不是普通文件；本工具不操作目录或符号链接`)
}

export const deleteFileTool = buildTool({
  name: DELETE_FILE_TOOL_NAME,
  description: '删除单个文件',
  prompt:
    '删除允许范围内的单个普通文件，并建立可恢复的精确检查点。不要用 RunCommand 删除明确文件。本工具不会删除目录、符号链接或执行递归删除。',
  inputSchema: z.object({
    path: z.string().describe('要删除的文件路径'),
  }),
  isReadOnly: false,
  kind: 'edit',
  extractPaths: (input) => [input.path],
  checkpointScope: (input, ctx) => ({
    kind: 'exact-files',
    paths: [resolveAllowed(ctx, input.path)],
  }),
  async renderDiff(input, ctx) {
    const absolute = resolveAllowed(ctx, input.path)
    const content = await readFile(absolute, 'utf8')
    return makeDiff(input.path, content, '')
  },
  async execute(input, ctx) {
    const absolute = resolveAllowed(ctx, input.path)
    try {
      await requireRegularFile(absolute, `文件 ${input.path}`)
      await unlink(absolute)
      return { data: `已删除 ${input.path}`, isError: false }
    } catch (error) {
      return {
        data: `删除失败：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
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
