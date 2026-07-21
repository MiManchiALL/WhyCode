import {
  WEB_PAGE_MAX_LINE_CHARS,
  WEB_PAGE_MAX_URL_CHARS,
} from '@whycode/core'
import {
  WEB_PAGE_MAX_CONTENT_CHARS,
  type ExtractedWebPage,
} from './content.ts'
import type { WebTextDocument } from './network.ts'

export interface WebPageWorkerRequest {
  id: string
  document: WebTextDocument
}

export type WebPageWorkerResponse =
  | { id: string; ok: true; result: ExtractedWebPage }
  | { id: string; ok: false; error: string }

export function isWebPageWorkerResponse(
  value: unknown,
  request: WebPageWorkerRequest,
): value is WebPageWorkerResponse {
  if (!isRecord(value) || value.id !== request.id || typeof value.ok !== 'boolean') return false
  if (!value.ok) return typeof value.error === 'string' && value.error.length <= 500
  if (!isRecord(value.result)) return false
  const result = value.result
  if (
    result.requestedUrl !== request.document.requestedUrl
    || result.finalUrl !== request.document.finalUrl
    || result.contentType !== request.document.contentType
    || typeof result.sourceTruncated !== 'boolean'
    || !Array.isArray(result.lines)
    || result.lines.length > WEB_PAGE_MAX_CONTENT_CHARS
    || result.requestedUrl.length > WEB_PAGE_MAX_URL_CHARS
    || result.finalUrl.length > WEB_PAGE_MAX_URL_CHARS
    || ('title' in result && (typeof result.title !== 'string' || result.title.length > 500))
  ) return false

  let contentChars = 0
  for (const [index, line] of result.lines.entries()) {
    if (typeof line !== 'string' || line.length > WEB_PAGE_MAX_LINE_CHARS) return false
    contentChars += line.length + (index > 0 ? 1 : 0)
    if (contentChars > WEB_PAGE_MAX_CONTENT_CHARS) return false
  }
  return true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
