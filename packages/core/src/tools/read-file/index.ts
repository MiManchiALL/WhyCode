import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { buildTool } from '../tool.ts'
import { resolveAllowed } from '../fs-utils.ts'

export const READ_FILE_TOOL_NAME = 'ReadFile'

const MAX_LINES = 1_000
const MAX_LINE_CHARS = 2_000
const BINARY_PROBE_BYTES = 512

async function isBinaryFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

function abortError(): Error {
  const error = new Error('读取已被中止')
  error.name = 'AbortError'
  return error
}

export const readFileTool = buildTool({
  name: READ_FILE_TOOL_NAME,
  description: '按行流式读取文本文件',
  prompt:
    '读取允许范围内的 UTF-8 文本文件，返回带行号的内容。默认最多返回 1000 行；用 offset/limit 分段读取大文件。读取会在获得所需行后立即停止，不会把整个大文件载入内存；超长单行会安全截断。二进制、图片和 PDF 请使用后续对应工具，不要当文本读取。',
  inputSchema: z.object({
    path: z.string().describe('文件路径（项目内或经用户授权的绝对路径）'),
    offset: z.number().int().min(1).optional().describe('起始行号，从 1 开始'),
    limit: z.number().int().min(1).max(MAX_LINES).optional().describe('最多读取行数，最大 1000'),
  }),
  isReadOnly: true,
  kind: 'read',
  extractPaths: (input) => [input.path],
  async execute(input, ctx) {
    const absolute = resolveAllowed(ctx, input.path)
    if (await isBinaryFile(absolute)) {
      return { data: `无法按文本读取二进制文件：${input.path}`, isError: true }
    }

    const startLine = input.offset ?? 1
    const limit = input.limit ?? MAX_LINES
    const stream = createReadStream(absolute, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    const output: string[] = []
    let lineNumber = 0
    let hasMore = false
    const onAbort = () => stream.destroy(abortError())
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true })

    try {
      for await (const line of lines) {
        lineNumber++
        if (lineNumber < startLine) continue
        if (output.length >= limit) {
          hasMore = true
          break
        }
        const shown =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}…[本行超过 ${MAX_LINE_CHARS} 字符，已截断]`
            : line
        output.push(`${String(lineNumber).padStart(5)}\t${shown}`)
      }
    } finally {
      ctx.abortSignal.removeEventListener('abort', onAbort)
      lines.close()
      stream.destroy()
    }

    if (ctx.abortSignal.aborted) throw abortError()
    if (output.length === 0) {
      return {
        data: lineNumber === 0 ? '（空文件）' : `（从第 ${startLine} 行起无内容；文件共 ${lineNumber} 行）`,
        isError: false,
      }
    }
    const note = hasMore
      ? `\n[内容已截断，可用 offset=${startLine + output.length} 继续读取]`
      : ''
    return { data: output.join('\n') + note, isError: false }
  },
})
