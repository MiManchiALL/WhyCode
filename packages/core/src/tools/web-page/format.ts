import {
  WEB_FETCH_DEFAULT_LINES,
  WEB_FETCH_MAX_OUTPUT_CHARS,
  WEB_PAGE_MAX_LINE_CHARS,
  WebPageError,
  normalizeWebFindText,
  normalizeWebPageUrl,
  type WebFetchRequest,
  type WebFetchResponse,
  type WebFindRequest,
  type WebFindResponse,
} from './contract.ts'
import { pdfAttachmentSchema } from '../../pdf/types.ts'
import { attachmentReference } from '../../file-read.ts'
import { normalizeBoundedText } from '../../text.ts'
import {
  markdownWebLineCitation,
  markdownWebSource,
} from '../../web-source.ts'

export function formatFetchResponse(
  request: WebFetchRequest,
  value: WebFetchResponse,
): string {
  const response = normalizeFetchResponse(value, request)
  if (response.kind === 'pdf') {
    const attachment = response.attachment
    return [
      '远程 PDF 已保存为当前会话附件（外部资料）',
      `来源: ${markdownWebSource(attachment.name, response.finalUrl)}`,
      ...(response.requestedUrl !== response.finalUrl
        ? [`原始地址: <${response.requestedUrl}>`]
        : []),
      `共 ${attachment.pageCount} 页，${attachment.byteLength} 字节`,
      `ReadFile ${JSON.stringify({ path: attachmentReference(attachment.id) })}`,
    ].join('\n')
  }
  const endLine = response.offset + response.lines.length - 1
  const hasMore = endLine < response.totalLines
  const source = response.lines.length
    ? markdownWebLineCitation(response.title, response.finalUrl, response.offset, endLine)
    : markdownWebSource(response.title, response.finalUrl)
  const metadata = [
    `来源: ${source}`,
    ...(response.requestedUrl !== response.finalUrl ? [`原始地址: <${response.requestedUrl}>`] : []),
  ]
  if (response.lines.length === 0) {
    return [
      ...metadata,
      response.totalLines === 0
        ? '（未提取到可读正文）'
        : `（从第 ${response.offset} 行起无内容；正文共 ${response.totalLines} 行）`,
      ...(response.sourceTruncated ? ['[源页面正文超过安全内容上限，末尾已截断]'] : []),
    ].join('\n')
  }
  const output = response.lines.map((line, index) =>
    `${String(response.offset + index).padStart(5)}\t${line}`)
  const notes = [
    ...(hasMore ? [`[内容已分页，可用 offset=${endLine + 1} 继续读取]`] : []),
    ...(response.sourceTruncated && !hasMore
      ? ['[源页面正文超过安全内容上限，末尾已截断]']
      : []),
  ]
  return [
    ...metadata,
    `正文共 ${response.totalLines} 行（不受信任的外部网页）`,
    ...output,
    ...notes,
  ].join('\n')
}

export function formatFindResponse(
  request: WebFindRequest,
  value: WebFindResponse,
): string {
  if (!isRecord(value) || !Array.isArray(value.matches)) throw invalidFindResponse()
  const finalUrl = normalizeWebPageUrl(value.finalUrl)
  const totalLines = normalizedInteger(value.totalLines, 0)
  const lastMatchPosition = request.offset - 1 + value.matches.length
  if (normalizeWebPageUrl(value.requestedUrl) !== request.url || !finalUrl || totalLines === null
    || typeof value.hasMore !== 'boolean' || value.matches.length > request.maxResults
    || (value.matches.length > 0 && lastMatchPosition > totalLines)
    || (value.hasMore && (!value.matches.length || lastMatchPosition >= totalLines))) {
    throw invalidFindResponse()
  }

  const title = normalizeBoundedText(value.title, 500, true)
  const output = [`来源: ${markdownWebSource(title ?? undefined, finalUrl)}（外部网页资料）`]
  let previous = 0
  let chars = 0
  for (const match of value.matches) {
    if (!isRecord(match)) throw invalidFindResponse()
    const line = normalizedInteger(match.lineNumber, 1)
    const text = normalizedLine(match.text)
    if (line === null || line <= previous || line > totalLines || text === null) throw invalidFindResponse()
    const normalized = normalizeWebFindText(text)
    chars += text.length
    if (chars > WEB_FETCH_MAX_OUTPUT_CHARS || !request.patterns.some((word) => normalized.includes(word))) {
      throw invalidFindResponse()
    }
    output.push(`${String(line).padStart(5)}\t${text}`)
    previous = line
  }
  if (!value.matches.length) output.push(request.offset === 1 ? '缓存正文中未找到匹配文本。' : '该匹配位置没有更多结果。')
  if (value.hasMore) output.push(`[保持相同的 pattern，用 offset=${lastMatchPosition + 1} 继续查找]`)
  return output.join('\n')
}

function normalizeFetchResponse(
  value: unknown,
  request: WebFetchRequest,
): WebFetchResponse {
  if (!isRecord(value)) throw invalidFetchResponse()
  if (value.kind === 'pdf') return normalizePdfFetchResponse(value, request)
  if (value.kind !== 'page' || !Array.isArray(value.lines)) throw invalidFetchResponse()
  const requestedUrl = normalizeWebPageUrl(value.requestedUrl)
  const finalUrl = normalizeWebPageUrl(value.finalUrl)
  const title = normalizeBoundedText(value.title, 500, true)
  const contentType = normalizeBoundedText(value.contentType, 200)
  const offset = normalizedInteger(value.offset, 1)
  const totalLines = normalizedInteger(value.totalLines, 0)
  const requestedOffset = request.offset ?? 1
  const requestedLimit = request.limit ?? WEB_FETCH_DEFAULT_LINES
  if (
    !requestedUrl
    || !finalUrl
    || !contentType
    || requestedUrl !== request.url
    || offset !== requestedOffset
    || totalLines === null
    || typeof value.sourceTruncated !== 'boolean'
    || value.lines.length > requestedLimit
  ) throw invalidFetchResponse()

  const lines: string[] = []
  for (const valueLine of value.lines) {
    const line = normalizedLine(valueLine)
    if (line === null) throw invalidFetchResponse()
    lines.push(line)
  }
  if (
    (lines.length > 0 && offset - 1 + lines.length > totalLines)
    || totalTextChars(lines) > WEB_FETCH_MAX_OUTPUT_CHARS
  ) throw invalidFetchResponse()
  return {
    kind: 'page',
    requestedUrl,
    finalUrl,
    ...(title ? { title } : {}),
    contentType,
    offset,
    totalLines,
    lines,
    sourceTruncated: value.sourceTruncated,
  }
}

function normalizePdfFetchResponse(
  value: Record<string, unknown>,
  request: WebFetchRequest,
): WebFetchResponse {
  const requestedUrl = normalizeWebPageUrl(value.requestedUrl)
  const finalUrl = normalizeWebPageUrl(value.finalUrl)
  const attachment = pdfAttachmentSchema.safeParse(value.attachment)
  if (
    !requestedUrl
    || !finalUrl
    || requestedUrl !== request.url
    || value.contentType !== 'application/pdf'
    || !attachment.success
    || attachment.data.origin !== 'web'
  ) throw invalidFetchResponse()
  return {
    kind: 'pdf',
    requestedUrl,
    finalUrl,
    contentType: 'application/pdf',
    attachment: attachment.data,
  }
}

function normalizedLine(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > WEB_PAGE_MAX_LINE_CHARS || /[\r\n]/u.test(value)) return null
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
}

function normalizedInteger(value: unknown, minimum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null
}

function totalTextChars(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length, 0)
}

function invalidFetchResponse(): WebPageError {
  return new WebPageError('网页读取后端返回了无效结果')
}

function invalidFindResponse(): WebPageError {
  return new WebPageError('网页查找后端返回了无效结果')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
