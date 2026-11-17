import { z } from 'zod'

export const COMMAND_PREVIEW_BYTES = 50 * 1024
export const COMMAND_PREVIEW_LINES = 2_000

export function commandTailPreview(tail: Buffer, startsAtLineBoundary: boolean): string {
  let start = startsAtLineBoundary ? 0 : tail.indexOf(10) + 1
  if (!startsAtLineBoundary && start === 0) return ''
  let lines = 0
  for (let index = tail.length - 1; index >= start; index--) {
    if (tail[index] === 10 && index < tail.length - 1 && ++lines === COMMAND_PREVIEW_LINES) {
      start = index + 1
      break
    }
  }
  return tail.subarray(start).toString('utf8')
}

const outputResultSchema = z.object({
  type: z.literal('command-output'),
  output: z.string(),
  totalBytes: z.number().int().nonnegative(),
  totalLines: z.number().int().nonnegative(),
  fullOutputPath: z.string().optional(),
  diagnostic: z.string().optional(),
}).strict()

export type CommandOutputResult = z.infer<typeof outputResultSchema>

export function readCommandOutputResult(data: string): CommandOutputResult | null {
  try {
    const result = outputResultSchema.safeParse(JSON.parse(data))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** JSON 转义也占时间线预算；继续按整行裁剪，保留文件引用和终态诊断。 */
export function serializeCommandOutputResult(result: CommandOutputResult): string {
  let budget = 60 * 1024 - JSON.stringify({ ...result, output: '' }).length
  const lines = result.output.match(/[^\n]*\n|[^\n]+$/g) ?? []
  let start = lines.length
  while (start > 0) {
    const size = JSON.stringify(lines[start - 1]).length - 2
    if (size > budget) break
    budget -= size
    start--
  }
  return JSON.stringify({ ...result, output: lines.slice(start).join('') })
}

export function commandOutputDetails(result: CommandOutputResult): string {
  return [
    `[输出过长，预览仅保留尾部完整行；共 ${result.totalBytes} 字节、${result.totalLines} 行]`,
    result.output || (result.fullOutputPath ? '（尾部单行超过预览上限，请读取日志）' : '（尾部单行超过预览上限，无法预览）'),
    result.fullOutputPath ? `完整日志：${result.fullOutputPath}\n可用 ReadFile 分页读取或 Grep 搜索。` : '',
    result.diagnostic,
  ].filter(Boolean).join('\n')
}
