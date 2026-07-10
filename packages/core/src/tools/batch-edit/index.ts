import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { buildTool, type ToolContext } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'
import { makeDiff } from '../write-edit/index.ts'

export const BATCH_EDIT_TOOL_NAME = 'BatchEdit'

const editSchema = z
  .object({
    path: z.string().describe('要修改的文件路径'),
    oldText: z.string().min(1).describe('必须与当前内容精确匹配的原文'),
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
    .describe('按顺序执行的精确替换；同一文件可以出现多次'),
})

type BatchEditInput = z.infer<typeof inputSchema>

interface StagedChanges {
  originals: Map<string, string>
  updated: Map<string, string>
  displayPaths: Map<string, string>
}

function replaceExact(
  content: string,
  edit: BatchEditInput['edits'][number],
): string {
  const first = content.indexOf(edit.oldText)
  if (first === -1) throw new Error(`oldText 在 ${edit.path} 中不存在`)
  if (edit.replaceAll) return content.split(edit.oldText).join(edit.newText)
  if (content.indexOf(edit.oldText, first + edit.oldText.length) !== -1) {
    throw new Error(`oldText 在 ${edit.path} 中出现多次；请提供更长上下文或设置 replaceAll=true`)
  }
  return content.slice(0, first) + edit.newText + content.slice(first + edit.oldText.length)
}

async function stageChanges(input: BatchEditInput, ctx: ToolContext): Promise<StagedChanges> {
  const staged: StagedChanges = {
    originals: new Map(),
    updated: new Map(),
    displayPaths: new Map(),
  }
  for (const edit of input.edits) {
    const absolute = resolveAllowed(ctx, edit.path)
    if (!staged.originals.has(absolute)) {
      const content = await readFile(absolute, 'utf8')
      staged.originals.set(absolute, content)
      staged.updated.set(absolute, content)
      staged.displayPaths.set(absolute, edit.path)
    }
    staged.updated.set(absolute, replaceExact(staged.updated.get(absolute)!, edit))
  }
  return staged
}

export const batchEditTool = buildTool({
  name: BATCH_EDIT_TOOL_NAME,
  description: '一次原子执行多处精确文本替换',
  prompt:
    '对一个或多个已有文本文件执行一批精确替换。所有 oldText 会先在内存中按顺序校验，全部有效后才写盘；任一校验失败时不会修改任何文件，写入中途失败也会尽力恢复。适合跨文件重命名、重复机械修改或一次完成多处相关编辑，能减少多轮 EditFile 调用。小型单处修改仍使用 EditFile。',
  inputSchema,
  isReadOnly: false,
  kind: 'edit',
  extractPaths: (input) => [...new Set(input.edits.map((edit) => edit.path))],
  checkpointScope: (input, ctx) => ({
    kind: 'exact-files',
    paths: [
      ...new Set(input.edits.map((edit) => resolveAllowed(ctx, edit.path))),
    ],
  }),
  async renderDiff(input, ctx) {
    const staged = await stageChanges(input, ctx)
    return [...staged.updated.entries()]
      .map(([absolute, content]) =>
        makeDiff(
          staged.displayPaths.get(absolute)!,
          staged.originals.get(absolute)!,
          content,
        ),
      )
      .filter(Boolean)
      .join('\n\n')
  },
  async execute(input, ctx) {
    let staged: StagedChanges
    try {
      staged = await stageChanges(input, ctx)
    } catch (error) {
      return {
        data: `批量编辑未执行：${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }

    const written: string[] = []
    try {
      for (const [absolute, content] of staged.updated) {
        await writeFile(absolute, content, 'utf8')
        written.push(absolute)
      }
    } catch (error) {
      const restored = await Promise.allSettled(
        written.map((absolute) =>
          writeFile(absolute, staged.originals.get(absolute)!, 'utf8'),
        ),
      )
      const failedRestores = restored.filter((result) => result.status === 'rejected').length
      return {
        data:
          `批量编辑写入失败：${error instanceof Error ? error.message : String(error)}` +
          (failedRestores > 0 ? `；另有 ${failedRestores} 个文件自动恢复失败，可使用检查点回滚` : '；已恢复此前写入'),
        isError: true,
      }
    }

    return {
      data: `已完成 ${input.edits.length} 处替换，涉及 ${staged.updated.size} 个文件`,
      isError: false,
    }
  },
})
