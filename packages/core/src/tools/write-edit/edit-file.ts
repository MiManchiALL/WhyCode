import { localWorkspaceIO, workspacePathKey } from '../../workspace/io.ts'
import { decodeWorkspaceText } from '../../workspace/read.ts'
import { z } from 'zod'
import { resolveAllowed } from '../fs-utils.ts'
import { buildTool, type ToolContext } from '../tool.ts'
import { makeDiff } from './diff.ts'
import { describeFileChange } from '../file-changes.ts'
import { isUnknownWorkspaceOutcome } from '../../workspace/errors.ts'

export const EDIT_FILE_TOOL_NAME = 'EditFile'

const editSchema = z
  .object({
    path: z.string().describe('要修改的已有文本文件路径'),
    oldText: z.string().min(1).describe('来自当前文件、需要精确匹配的原文'),
    newText: z.string().describe('替换后的文本'),
    replaceAll: z.boolean().optional().describe('是否替换该文件中的全部匹配，默认 false'),
  })
  .refine((edit) => edit.oldText !== edit.newText, {
    message: 'oldText 与 newText 不能相同',
  })

const inputSchema = z.object({
  edits: z
    .array(editSchema)
    .min(1)
    .max(50)
    .describe('一处或多处精确替换；可以涉及同一文件或多个文件'),
})

type EditFileInput = z.infer<typeof inputSchema>
type Edit = EditFileInput['edits'][number]

interface Replacement {
  start: number
  end: number
  newText: string
}

interface StagedFile {
  absolute: string
  displayPath: string
  original: string
  updated: string
}

function stageEdit(normalized: string, edit: Edit, replacements: Replacement[]): void {
  const oldText = edit.oldText.replace(/\r\n?/g, '\n')
  const newText = edit.newText.replace(/\r\n?/g, '\n')
  let start = normalized.indexOf(oldText)
  if (start < 0) throw new Error(`oldText 在 ${edit.path} 中不存在`)
  if (oldText === newText) throw new Error(`${edit.path} 的替换内容与原文相同`)
  do {
    const end = start + oldText.length
    replacements.push({ start, end, newText })
    start = normalized.indexOf(oldText, end)
    if (start >= 0 && !edit.replaceAll) {
      throw new Error(`oldText 在 ${edit.path} 中出现多次；请提供更长上下文或设置 replaceAll=true`)
    }
  } while (start >= 0)
}

function applyReplacements(original: string, edits: Edit[]): string {
  const normalized = original.replace(/\r\n?/g, '\n')
  const replacements: Replacement[] = []
  for (const edit of edits) stageEdit(normalized, edit, replacements)
  // 匹配按逻辑换行定位，写回时单向映射到原始字符位置，未编辑的字节原样保留。
  const breaks = /\r\n|\r|\n/g
  let nextBreak = breaks.exec(original)
  let extra = 0
  let previousEol = '\n'
  function originalOffset(offset: number): number {
    while (nextBreak && nextBreak.index < offset + extra) {
      previousEol = nextBreak[0]
      extra += previousEol.length - 1
      nextBreak = breaks.exec(original)
    }
    return offset + extra
  }
  let cursor = 0
  const parts: string[] = []
  for (const replacement of replacements.sort((a, b) => a.start - b.start)) {
    const start = originalOffset(replacement.start)
    if (start < cursor) {
      throw new Error(`对 ${edits[0]!.path} 的替换存在重叠或嵌套`)
    }
    const eol = nextBreak?.[0] ?? previousEol
    parts.push(original.slice(cursor, start), eol === '\n' ? replacement.newText : replacement.newText.replaceAll('\n', eol))
    cursor = originalOffset(replacement.end)
  }
  parts.push(original.slice(cursor))
  let updated = parts.join('')
  if (original.startsWith('\uFEFF') && !updated.startsWith('\uFEFF')) updated = '\uFEFF' + updated
  if (updated === original) throw new Error(`${edits[0]!.path} 的替换内容与原文相同`)
  return updated
}

async function groupEdits(input: EditFileInput, ctx: ToolContext) {
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const groups = new Map<string, { absolute: string; edits: Edit[] }>()
  for (const edit of input.edits) {
    const absolute = await resolveAllowed(ctx, edit.path)
    const key = workspacePathKey(io, absolute)
    const group = groups.get(key)
    if (group) group.edits.push(edit)
    else groups.set(key, { absolute, edits: [edit] })
  }
  return [...groups.values()]
}

async function stageChanges(input: EditFileInput, ctx: ToolContext): Promise<StagedFile[]> {
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const files: StagedFile[] = []
  for (const { absolute, edits } of await groupEdits(input, ctx)) {
    const displayPath = edits[0]!.path
    const original = decodeWorkspaceText(await io.fs.readFile(absolute))
    if (original === undefined) throw new Error(`${displayPath} 不是可编辑的 UTF-8 文本`)
    files.push({ absolute, displayPath, original, updated: applyReplacements(original, edits) })
  }
  return files
}

export const editFileTool = buildTool({
  name: EDIT_FILE_TOOL_NAME,
  description: '原子执行一处或多处精确文本替换',
  prompt:
    '在一个或多个已有文本文件中原子执行精确替换。先用 ReadFile 读取相关文件；每个 edits[].oldText 都针对调用开始时的原始文件，须保留精确缩进，并尽量短而唯一，只有明确要替换全部匹配时才设置 replaceAll=true。同一文件内的替换不得重叠或嵌套；全部替换会先预检，通过后才写盘。新建文件或整文件重写使用 WriteFile。',
  inputSchema,
  isReadOnly: false,
  kind: 'edit',
  extractPaths: (input) => [...new Set(input.edits.map((edit) => edit.path))],
  checkpointScope: async (input, ctx) => ({
    kind: 'exact-files',
    paths: (await groupEdits(input, ctx)).map(group => group.absolute),
  }),
  async renderDiff(input, ctx) {
    return makeDiff(await stageChanges(input, ctx))
  },
  async execute(input, ctx) {
    const io = ctx.workspaceIO ?? localWorkspaceIO
    const { writeFile } = io.fs

    let files: StagedFile[]
    try {
      files = await stageChanges(input, ctx)
    } catch (error) {
      return {
        data: `编辑未执行：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }

    const attempted: StagedFile[] = []
    try {
      for (const file of files) {
        attempted.push(file)
        await writeFile(file.absolute, file.updated, 'utf8')
      }
    } catch (error) {
      if (isUnknownWorkspaceOutcome(error)) return { data: error.message, isError: true }
      const restored = await Promise.allSettled(
        attempted.map((file) => writeFile(file.absolute, file.original, 'utf8')),
      )
      const failedRestores = restored.filter((result) => result.status === 'rejected').length
      return {
        data:
          `编辑写入失败：${error instanceof Error ? error.message : String(error)}`
          + (failedRestores > 0
            ? `；另有 ${failedRestores} 个文件自动恢复失败，可使用检查点回滚`
            : '；已恢复此前写入'),
        isError: true,
      }
    }

    return {
      data: input.edits.length === 1
        ? `已编辑 ${input.edits[0]!.path}`
        : `已完成 ${input.edits.length} 处替换，涉及 ${files.length} 个文件`,
      isError: false,
      fileChanges: files.map((file) =>
        describeFileChange(file.displayPath, file.original, file.updated)),
    }
  },
})
