import { z } from 'zod'
import type { PdfAttachment } from '../../pdf/types.ts'

export const WEB_PAGE_MAX_URL_CHARS = 2_048
export const WEB_PAGE_MAX_LINE_CHARS = 4_096
export const WEB_FETCH_MAX_LINES = 100
export const WEB_FETCH_MAX_OUTPUT_CHARS = 9_000
export const WEB_FIND_MAX_PATTERN_CHARS = 200
export const WEB_FIND_MAX_CONTEXT_LINES = 2
export const WEB_FIND_MAX_RESULTS = 10
export const WEB_FIND_MAX_OUTPUT_CHARS = 9_000

const webPageUrlSchema = z.string()
  .trim()
  .min(1)
  .max(WEB_PAGE_MAX_URL_CHARS)
  .refine((value) => normalizeWebPageUrl(value) !== null, {
    message: '只接受不含账号密码的 HTTP/HTTPS URL',
  })
  .overwrite((value) => normalizeWebPageUrl(value) ?? value)

export const webFetchRequestSchema = z.object({
  url: webPageUrlSchema.describe('要读取的公开网页或远程 PDF URL'),
  offset: z.number()
    .int()
    .min(1)
    .optional()
    .describe('仅文本网页有效：起始行号，从 1 开始；继续读取时使用上次结果给出的 next offset'),
  limit: z.number()
    .int()
    .min(1)
    .max(WEB_FETCH_MAX_LINES)
    .optional()
    .describe(`仅文本网页有效：最多返回多少行，默认及最大均为 ${WEB_FETCH_MAX_LINES}`),
})

export const webFindRequestSchema = z.object({
  url: webPageUrlSchema.describe('此前已经用 WebFetch 读取过的同一网页 URL'),
  pattern: z.string()
    .trim()
    .min(1)
    .max(WEB_FIND_MAX_PATTERN_CHARS)
    .overwrite((value) => value.replace(/\s+/gu, ' ').trim())
    .describe('要查找的普通文本，不是正则表达式'),
  context: z.number()
    .int()
    .min(0)
    .max(WEB_FIND_MAX_CONTEXT_LINES)
    .default(WEB_FIND_MAX_CONTEXT_LINES)
    .describe('每个匹配前后附带的上下文行数'),
  max_results: z.number()
    .int()
    .min(1)
    .max(WEB_FIND_MAX_RESULTS)
    .default(WEB_FIND_MAX_RESULTS)
    .describe(`最多返回多少个匹配，最大 ${WEB_FIND_MAX_RESULTS}`),
})

export type WebFetchToolInput = z.infer<typeof webFetchRequestSchema>
export type WebFindToolInput = z.infer<typeof webFindRequestSchema>

export interface WebFetchRequest {
  url: string
  offset?: number
  limit?: number
}

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
  pattern: string
  context: number
  maxResults: number
}

export interface WebFindMatch {
  lineNumber: number
  context: readonly WebPageLine[]
}

export interface WebFindResponse {
  requestedUrl: string
  finalUrl: string
  title?: string
  totalLines: number
  matches: readonly WebFindMatch[]
}

export type WebFetchHandler = (
  request: WebFetchRequest,
  abortSignal: AbortSignal,
) => Promise<WebFetchResponse>

export type WebFindHandler = (
  request: WebFindRequest,
  abortSignal: AbortSignal,
) => Promise<WebFindResponse>

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
