import type { Readable } from 'node:stream'
import { estimateTextTokens } from '../../context/tokens.ts'
import { unicodeSafePrefix } from '../../text.ts'
import { localWorkspaceIO, type WorkspaceIO } from '../../workspace/io.ts'
import { resolveAllowed } from '../fs-utils.ts'
import type { ToolContext, ToolResult } from '../tool.ts'
import { lineParts } from './lines.ts'

const MAX_BYTES = 256 * 1024
const MAX_TOKENS = 25_000

interface TextRange {
  offset: number
  limit: number
  column: number
}

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
  input: { path: string } & Partial<TextRange>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const absolute = await resolveAllowed(ctx, input.path)
  const stat = await io.fs.stat(absolute)
  if (!stat.isFile()) return { data: '路径不是文件，请使用 ListDir 查看目录', isError: true }
  if (await isBinaryFile(absolute, io)) {
    return { data: `无法按文本读取二进制文件：${input.path}`, isError: true }
  }

  ctx.abortSignal.throwIfAborted()
  const stream = io.fs.createReadStream(absolute, { encoding: 'utf8', signal: ctx.abortSignal })
  try {
    const result = await readPage(stream, {
      offset: input.offset ?? 1, limit: input.limit ?? Infinity, column: input.column ?? 1,
    })
    ctx.abortSignal.throwIfAborted()
    return result
  } finally {
    stream.destroy()
  }
}

async function readPage(stream: Readable, range: TextRange): Promise<ToolResult> {
  const { offset: startLine, limit, column } = range
  let body = ''
  let bytes = 0
  let lastLine = 0
  let remainingColumn = column > 1 ? column : 0
  let nextLine: number | undefined
  const lineEnds: number[] = []
  for await (const part of lineParts(stream)) {
    const newLine = part.number !== lastLine
    lastLine = part.number
    if (lastLine < startLine) continue
    if (lastLine > startLine && remainingColumn > 0) break
    if (lastLine - startLine >= limit) {
      nextLine = lastLine
      break
    }
    let start = 0
    if (remainingColumn > 0) {
      for (const char of part.text) {
        if (--remainingColumn === 0) break
        start += char.length
      }
    }
    if (newLine) {
      if (body.length) lineEnds.push(body.length)
      const label = lastLine === startLine && column > 1 ? `${lastLine}:${column}` : String(lastLine)
      const prefix = `${body.length ? '\n' : ''}${label.padStart(5)}\t`
      body += prefix
      bytes += prefix.length
    }
    const text = part.text.slice(start, start + Math.max(0, MAX_BYTES + 1 - bytes))
    body += text
    bytes += Buffer.byteLength(text)
    if (bytes > MAX_BYTES) break
  }
  if (!body) {
    return { data: lastLine ? `（从第 ${startLine} 行起无内容；文件共 ${lastLine} 行）` : '（空文件）', isError: false }
  }
  if (remainingColumn > 0) {
    return { data: `第 ${startLine} 行只有 ${column - remainingColumn} 个字符，无法从第 ${column} 列读取。`, isError: true }
  }
  return { data: formatPage(body, lineEnds, range, nextLine), isError: false }
}

function formatPage(body: string, lineEnds: number[], range: TextRange, nextLine?: number): string {
  const { offset: line, column, limit } = range
  const whole = body + (nextLine === undefined ? '' : lineNotice(nextLine))
  if (fits(whole)) return whole

  const completeLines = (count: number) => body.slice(0, lineEnds[count - 1]) + lineNotice(line + count, limit - count)
  const count = largestFit(lineEnds.length, n => fits(completeLines(n)))
  if (count) return completeLines(count)

  const labelEnd = body.indexOf('\t') + 1
  const content = body.slice(labelEnd, lineEnds[0])
  const label = body.slice(0, labelEnd)
  const notice = (next: number) => `\n[第 ${line} 行仅显示片段，请用 offset=${line}, column=${next}${limitHint(limit)} 继续读取]`
  // 用 UTF-16 长度预留列号位数，且至少留下一个字符供续读游标定位。
  const trailer = notice(column + content.length)
  const length = largestFit(content.length - 1, n => fits(label + content.slice(0, n) + trailer))
  const fragment = unicodeSafePrefix(content, length)
  let nextColumn = column
  for (const _ of fragment) nextColumn++
  return label + fragment + notice(nextColumn)
}

function lineNotice(next: number, remaining = Infinity): string {
  return `\n[后续还有内容，请从第 ${next} 行继续读取（offset=${next}${limitHint(remaining)}）]`
}

function limitHint(limit: number): string {
  return Number.isFinite(limit) ? `, limit=${limit}` : ''
}

function fits(text: string): boolean {
  return Buffer.byteLength(text) <= MAX_BYTES && estimateTextTokens(text) <= MAX_TOKENS
}

function largestFit(max: number, fitsCount: (count: number) => boolean): number {
  let low = 0
  let high = max
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fitsCount(mid)) low = mid
    else high = mid - 1
  }
  return low
}
