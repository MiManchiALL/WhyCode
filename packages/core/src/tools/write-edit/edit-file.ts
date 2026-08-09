import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { resolveAllowed } from '../fs-utils.ts'
import { buildTool, type ToolContext } from '../tool.ts'
import { makeDiff } from './diff.ts'

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
  replacements: Replacement[]
  updated: string
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function findMatches(content: string, oldText: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = []
  let from = 0
  while (from <= content.length - oldText.length) {
    const start = content.indexOf(oldText, from)
    if (start === -1) break
    matches.push({ start, end: start + oldText.length })
    from = start + oldText.length
  }
  return matches
}

function stageEdit(file: StagedFile, edit: Edit): void {
  const matches = findMatches(file.original, edit.oldText)
  if (matches.length === 0) throw new Error(`oldText 在 ${edit.path} 中不存在`)
  if (!edit.replaceAll && matches.length > 1) {
    throw new Error(`oldText 在 ${edit.path} 中出现多次；请提供更长上下文或设置 replaceAll=true`)
  }
  for (const match of edit.replaceAll ? matches : matches.slice(0, 1)) {
    file.replacements.push({ ...match, newText: edit.newText })
  }
}

function applyReplacements(file: StagedFile): string {
  const replacements = [...file.replacements].sort((left, right) => left.start - right.start)
  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1]!
    const current = replacements[index]!
    if (current.start < previous.end) {
      throw new Error(`对 ${file.displayPath} 的替换存在重叠或嵌套`)
    }
  }

  let updated = file.original
  for (const replacement of replacements.reverse()) {
    updated =
      updated.slice(0, replacement.start)
      + replacement.newText
      + updated.slice(replacement.end)
  }
  return updated
}

async function stageChanges(input: EditFileInput, ctx: ToolContext): Promise<StagedFile[]> {
  const files = new Map<string, StagedFile>()
  for (const edit of input.edits) {
    const absolute = resolveAllowed(ctx, edit.path)
    const key = pathKey(absolute)
    let file = files.get(key)
    if (!file) {
      const original = await readFile(absolute, 'utf8')
      file = {
        absolute,
        displayPath: edit.path,
        original,
        replacements: [],
        updated: original,
      }
      files.set(key, file)
    }
    stageEdit(file, edit)
  }

  for (const file of files.values()) file.updated = applyReplacements(file)
  return [...files.values()]
}

function resolvedEditPaths(input: EditFileInput, ctx: ToolContext): string[] {
  const paths = new Map<string, string>()
  for (const edit of input.edits) {
    const absolute = resolveAllowed(ctx, edit.path)
    paths.set(pathKey(absolute), absolute)
  }
  return [...paths.values()]
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
  checkpointScope: (input, ctx) => ({
    kind: 'exact-files',
    paths: resolvedEditPaths(input, ctx),
  }),
  async renderDiff(input, ctx) {
    const files = await stageChanges(input, ctx)
    return files
      .map((file) => makeDiff(file.displayPath, file.original, file.updated))
      .filter(Boolean)
      .join('\n\n')
  },
  async execute(input, ctx) {
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
    }
  },
})
