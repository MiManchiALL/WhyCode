import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveInProject } from '../fs-utils.ts'

export const WRITE_FILE_TOOL_NAME = 'WriteFile'
export const EDIT_FILE_TOOL_NAME = 'EditFile'

/** 极简 unified diff（无第三方依赖）：整文件旧/新对比，供审批 UI 展示 */
export function makeDiff(path: string, oldText: string, newText: string): string {
  if (oldText === newText) return ''
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const out: string[] = [`--- ${path}`, `+++ ${path}`]
  // 找公共前后缀，只展示中间变化段
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  out.push(`@@ -${start + 1},${endOld - start} +${start + 1},${endNew - start} @@`)
  for (let i = start; i < endOld; i++) out.push(`-${oldLines[i]}`)
  for (let i = start; i < endNew; i++) out.push(`+${newLines[i]}`)
  return out.join('\n')
}

export const writeFileTool = buildTool({
  name: WRITE_FILE_TOOL_NAME,
  description: '写入/创建文件',
  prompt:
    '将完整内容写入项目内的文件（覆盖已有内容，自动创建父目录）。只适合新文件或整文件重写；修改已有文件优先用 EditFile。',
  inputSchema: z.object({
    path: z.string().describe('文件路径'),
    content: z.string().describe('完整文件内容'),
  }),
  isReadOnly: false,
  needsApproval: () => true,
  async renderDiff(input, ctx) {
    const abs = resolveInProject(ctx.projectDir, input.path)
    const old = await readFile(abs, 'utf-8').catch(() => '')
    return makeDiff(input.path, old, input.content)
  },
  async execute(input, ctx) {
    const abs = resolveInProject(ctx.projectDir, input.path)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, input.content, 'utf-8')
    return { data: `已写入 ${input.path}`, isError: false }
  },
})

export const editFileTool = buildTool({
  name: EDIT_FILE_TOOL_NAME,
  description: '编辑文件（精确替换）',
  prompt:
    '在项目文件中做精确字符串替换。oldText 必须与文件现有内容完全一致且唯一（含缩进），否则失败。先用 ReadFile 确认内容。',
  inputSchema: z.object({
    path: z.string().describe('文件路径'),
    oldText: z.string().describe('要替换的原文（必须唯一匹配）'),
    newText: z.string().describe('替换后的文本'),
  }),
  isReadOnly: false,
  needsApproval: () => true,
  async renderDiff(input, ctx) {
    const abs = resolveInProject(ctx.projectDir, input.path)
    const old = await readFile(abs, 'utf-8')
    const idx = old.indexOf(input.oldText)
    if (idx === -1) return undefined
    return makeDiff(input.path, old, old.replace(input.oldText, input.newText))
  },
  async execute(input, ctx) {
    const abs = resolveInProject(ctx.projectDir, input.path)
    const old = await readFile(abs, 'utf-8')
    const first = old.indexOf(input.oldText)
    if (first === -1) {
      return { data: `失败：oldText 在 ${input.path} 中不存在`, isError: true }
    }
    if (old.indexOf(input.oldText, first + 1) !== -1) {
      return { data: `失败：oldText 在 ${input.path} 中出现多次，请提供更长的唯一上下文`, isError: true }
    }
    await writeFile(abs, old.replace(input.oldText, input.newText), 'utf-8')
    return { data: `已编辑 ${input.path}`, isError: false }
  },
})
