import { estimateTextTokens } from '../../context/tokens.ts'
import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import { resolveAllowed } from '../fs-utils.ts'
import type { ToolContext, ToolResult } from '../tool.ts'
import { boundedLines } from './lines.ts'

const MAX_BYTES = 256 * 1024
const MAX_TOKENS = 25_000

async function isBinaryFile(path: string, io: WorkspaceIO): Promise<boolean> {
  const handle = await io.fs.open(path, 'r')
  try {
    const buffer = Buffer.alloc(512)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

export async function readText(
  input: { path: string; offset?: number; limit?: number },
  ctx: ToolContext,
): Promise<ToolResult> {
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const absolute = await resolveAllowed(ctx, input.path)
  const stat = await io.fs.stat(absolute)
  if (!stat.isFile()) return { data: '路径不是文件，请使用 ListDir 查看目录', isError: true }
  if (input.limit === undefined && stat.size > MAX_BYTES) return tooLarge()
  if (await isBinaryFile(absolute, io)) {
    return { data: `无法按文本读取二进制文件：${input.path}`, isError: true }
  }

  const startLine = input.offset ?? 1
  const limit = input.limit ?? Infinity
  ctx.abortSignal.throwIfAborted()
  const stream = io.fs.createReadStream(absolute, { encoding: 'utf8', signal: ctx.abortSignal })
  const output: string[] = []
  let lineNumber = 0
  let outputBytes = 0
  let hasMore = false
  try {
    // 只保留有界前缀用于检测超限，绝不把被截断的行作为成功结果返回。
    for await (const line of boundedLines(stream, MAX_BYTES)) {
      lineNumber++
      if (lineNumber < startLine) continue
      if (output.length >= limit) {
        hasMore = true
        break
      }
      const numbered = `${String(lineNumber).padStart(5)}\t${line}`
      outputBytes += Buffer.byteLength(numbered, 'utf8') + 1
      if (outputBytes > MAX_BYTES) return tooLarge()
      output.push(numbered)
    }
  } finally {
    stream.destroy()
  }
  ctx.abortSignal.throwIfAborted()
  if (output.length === 0) {
    return {
      data: lineNumber === 0 ? '（空文件）' : `（从第 ${startLine} 行起无内容；文件共 ${lineNumber} 行）`,
      isError: false,
    }
  }
  const data = output.join('\n')
  if (estimateTextTokens(data) > MAX_TOKENS) return tooLarge()
  const note = hasMore ? `\n[后续还有内容，请从第 ${startLine + output.length} 行继续读取]` : ''
  return { data: data + note, isError: false }
}

function tooLarge(): ToolResult {
  return {
    data: '文本超过单次读取的 256 KiB 或约 25,000 token 上限。请使用 offset 和 limit 缩小读取范围，或使用 Grep 查找所需内容。',
    isError: true,
  }
}
