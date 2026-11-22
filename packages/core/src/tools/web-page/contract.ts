import { z } from 'zod'
import type { PdfAttachment } from '../../pdf/types.ts'

export const WEB_PAGE_MAX_URL_CHARS = 2_048
export const WEB_PAGE_MAX_LINE_CHARS = 4_096
export const WEB_FETCH_DEFAULT_LINES = 100
export const WEB_FETCH_MAX_LINES = 300
export const WEB_FETCH_MAX_OUTPUT_CHARS = 24_000
export const WEB_FETCH_DEFAULT_RESULTS = 20
const MAX_RESULTS = 50
const MAX_PATTERNS = 8

const webPageUrlSchema = z.string()
  .trim()
  .min(1)
  .max(WEB_PAGE_MAX_URL_CHARS)
  .refine((value) => normalizeWebPageUrl(value) !== null, {
    message: '只接受不含账号密码的 HTTP/HTTPS URL',
  })
  .overwrite((value) => normalizeWebPageUrl(value) ?? value)

const keyword = z.string().trim().min(1).max(200)
  .overwrite((value) => value.replace(/\s+/gu, ' '))

export const webFetchRequestSchema = z.strictObject({
  url: webPageUrlSchema.describe('要读取的公开网页或远程 PDF URL'),
  offset: z.number()
    .int()
    .min(1)
    .optional()
    .describe('从 1 开始。读取时为正文行号，查找时为匹配结果序号，续查用上次返回的 offset'),
  limit: z.number()
    .int()
    .min(1)
    .max(WEB_FETCH_MAX_LINES)
    .optional()
    .describe(`仅用于读取正文，默认 ${WEB_FETCH_DEFAULT_LINES} 行，最多 ${WEB_FETCH_MAX_LINES} 行`),
  pattern: z.union([keyword, z.array(keyword).min(1).max(MAX_PATTERNS)]).optional()
    .describe('在缓存正文中做不区分大小写的字面查找，匹配任一关键词'),
  max_results: z.number()
    .int()
    .min(1)
    .max(MAX_RESULTS)
    .optional()
    .describe(`仅用于查找，所有关键词每页合计的匹配行数，默认 ${WEB_FETCH_DEFAULT_RESULTS}，最大 ${MAX_RESULTS}`),
}).superRefine((input, ctx) => {
  if (input.pattern === undefined && input.max_results !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['max_results'], message: 'max_results 需要与 pattern 一起使用' })
  }
  if (input.pattern !== undefined && input.limit !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['limit'], message: 'limit 仅用于读取正文，查找数量请用 max_results' })
  }
})

export type WebFetchToolInput = z.infer<typeof webFetchRequestSchema>
export type WebFetchRequest = Pick<WebFetchToolInput, 'url' | 'offset' | 'limit'>

export interface WebPageLine {
  lineNumber: number
  text: string
}

export interface WebFetchPageResponse {
  kind: 'page'
  requestedUrl: string
  finalUrl: string
  title?: string
  contentType: string
  offset: number
  totalLines: number
  lines: readonly string[]
  /** 确定性正文提取命中了宿主的整页内容上限。 */
  sourceTruncated: boolean
}

export interface WebFetchPdfResponse {
  kind: 'pdf'
  requestedUrl: string
  finalUrl: string
  contentType: 'application/pdf'
  attachment: PdfAttachment
}

export type WebFetchResponse = WebFetchPageResponse | WebFetchPdfResponse

export interface WebFindRequest {
  url: string
  patterns: readonly string[]
  offset: number
  maxResults: number
}

export interface WebFindResponse {
  requestedUrl: string
  finalUrl: string
  title?: string
  totalLines: number
  matches: readonly WebPageLine[]
  hasMore: boolean
}

export interface WebPageReader {
  fetchPage(request: WebFetchRequest, abortSignal: AbortSignal): Promise<WebFetchResponse>
  findInPage(request: WebFindRequest, abortSignal: AbortSignal): Promise<WebFindResponse>
}

export function normalizeWebFindText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ')
}

/** 宿主只用此错误传递已脱敏、可直接展示的网页读取故障。 */
export class WebPageError extends Error {
  override readonly name = 'WebPageError'
}

export function normalizeWebPageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > WEB_PAGE_MAX_URL_CHARS) return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}
