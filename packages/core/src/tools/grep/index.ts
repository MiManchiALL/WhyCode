import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveInProject, IGNORED_DIRS } from '../fs-utils.ts'

export const GREP_TOOL_NAME = 'Grep'

const MAX_MATCHES = 100
const MAX_FILE_BYTES = 1024 * 1024

/** 简单的二进制文件嗅探：前 512 字节含 NUL 即跳过 */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 512)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export const grepTool = buildTool({
  name: GREP_TOOL_NAME,
  description: '在文件内容中搜索',
  prompt:
    '在项目文件内容中按正则表达式搜索。返回 "路径:行号:行内容" 列表。可用 include 限定文件名模式（如 "*.ts"）。',
  inputSchema: z.object({
    pattern: z.string().describe('正则表达式（JavaScript 语法）'),
    include: z.string().optional().describe('限定文件名，如 "*.ts"，默认所有文本文件'),
    path: z.string().optional().describe('限定搜索目录，默认项目根目录'),
  }),
  isReadOnly: true,
  needsApproval: () => false,
  async execute(input, ctx) {
    const re = new RegExp(input.pattern)
    const includeRe = input.include
      ? new RegExp(
          `^${input.include.replaceAll(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`,
        )
      : null
    const root = resolveInProject(ctx.projectDir, input.path ?? '.')
    const matches: string[] = []

    async function search(dir: string): Promise<void> {
      if (matches.length >= MAX_MATCHES) return
      const entries = await readdir(dir, { withFileTypes: true })
      for (const e of entries) {
        if (matches.length >= MAX_MATCHES) return
        if (IGNORED_DIRS.has(e.name)) continue
        const full = join(dir, e.name)
        if (e.isDirectory()) {
          await search(full)
        } else if (!includeRe || includeRe.test(e.name)) {
          const buf = await readFile(full).catch(() => null)
          if (!buf || buf.length > MAX_FILE_BYTES || looksBinary(buf)) continue
          const rel = full.slice(ctx.projectDir.length + 1).replaceAll('\\', '/')
          const lines = buf.toString('utf-8').split('\n')
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              matches.push(`${rel}:${i + 1}:${lines[i]!.trim().slice(0, 200)}`)
              if (matches.length >= MAX_MATCHES) break
            }
          }
        }
      }
    }

    await search(root)
    const note =
      matches.length >= MAX_MATCHES ? `\n[已达 ${MAX_MATCHES} 条上限，结果可能不全]` : ''
    return { data: matches.join('\n') + note || '（无匹配）', isError: false }
  },
})
