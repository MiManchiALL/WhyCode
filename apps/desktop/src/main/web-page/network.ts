import { PDF_ATTACHMENT_MAX_SOURCE_BYTES, WebPageError } from '@whycode/core'
import {
  assertPublicWebTarget,
  parseWebPageUrl,
  type WebHostResolver,
} from './url-safety.ts'

export const WEB_DOCUMENT_MAX_BYTES = 5_000_000
export const WEB_PDF_MAX_BYTES = PDF_ATTACHMENT_MAX_SOURCE_BYTES
export const WEB_DOCUMENT_MAX_REDIRECTS = 5
export const WEB_DOCUMENT_TIMEOUT_MS = 20_000

export type WebPageFetchInit = RequestInit & { bypassCustomProtocolHandlers?: boolean }
export type WebPageFetch = (
  input: string,
  init: WebPageFetchInit,
) => Promise<Response>

interface WebDocumentBase {
  requestedUrl: string
  finalUrl: string
  contentType: string
}

export interface WebTextDocument extends WebDocumentBase {
  kind: 'text'
  text: string
}

export interface WebPdfDocument extends WebDocumentBase {
  kind: 'pdf'
  contentType: 'application/pdf'
  bytes: Uint8Array
}

export type WebDocument = WebTextDocument | WebPdfDocument

export interface WebDocumentFetcherOptions {
  fetchImpl: WebPageFetch
  resolveHost: WebHostResolver
  timeoutMs?: number
}

type FetchHopResult =
  | { redirectUrl: URL }
  | { kind: 'text'; contentType: string; text: string }
  | { kind: 'pdf'; contentType: 'application/pdf'; bytes: Uint8Array }

export function createWebDocumentFetcher(options: WebDocumentFetcherOptions) {
  return async (requestedUrl: string, abortSignal: AbortSignal): Promise<WebDocument> => {
    const initialUrl = parseWebPageUrl(requestedUrl)
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs ?? WEB_DOCUMENT_TIMEOUT_MS)
    const signal = AbortSignal.any([abortSignal, timeoutSignal])
    try {
      return await fetchFollowingRedirects(initialUrl, options, signal)
    } catch (error) {
      if (error instanceof WebPageError) throw error
      if (abortSignal.aborted) throw new WebPageError('网页读取已取消')
      if (timeoutSignal.aborted) throw new WebPageError('网页读取请求超时')
      throw new WebPageError('无法连接目标网站')
    }
  }
}

async function fetchFollowingRedirects(
  initialUrl: URL,
  options: WebDocumentFetcherOptions,
  signal: AbortSignal,
): Promise<WebDocument> {
  let currentUrl = initialUrl
  for (let redirects = 0; ; redirects++) {
    const result = await fetchHop(currentUrl, options, signal)
    if ('redirectUrl' in result) {
      if (redirects >= WEB_DOCUMENT_MAX_REDIRECTS) {
        throw new WebPageError('目标网站重定向次数过多')
      }
      currentUrl = result.redirectUrl
      continue
    }
    return {
      requestedUrl: initialUrl.toString(),
      finalUrl: currentUrl.toString(),
      ...result,
    }
  }
}

async function fetchHop(
  url: URL,
  options: WebDocumentFetcherOptions,
  signal: AbortSignal,
): Promise<FetchHopResult> {
  await assertPublicWebTarget(url, options.resolveHost, signal)
  const response = await options.fetchImpl(url.toString(), {
    method: 'GET',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/pdf,text/markdown,text/plain;q=0.9,*/*;q=0.1',
    },
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'manual',
    referrerPolicy: 'no-referrer',
    signal,
    bypassCustomProtocolHandlers: true,
  })
  if (isRedirect(response.status)) {
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location) throw new WebPageError('目标网站返回了缺少地址的重定向')
    return { redirectUrl: redirectUrl(location, url) }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw httpStatusError(response.status)
  }

  const declaredType = parseContentType(response.headers.get('content-type'))
  const mayBePdf = declaredType.mediaType === 'application/pdf'
    || (declaredType.mediaType === 'application/octet-stream' && url.pathname.toLowerCase().endsWith('.pdf'))
  if (declaredType.mediaType && !isSupportedTextContentType(declaredType.mediaType) && !mayBePdf) {
    await response.body?.cancel().catch(() => {})
    throw new WebPageError(`暂不支持读取此网页类型（${declaredType.mediaType}）`)
  }
  const bytes = await readBoundedBody(response, mayBePdf ? WEB_PDF_MAX_BYTES : WEB_DOCUMENT_MAX_BYTES)
  const contentType = declaredType.mediaType ?? sniffContentType(bytes)
  if (isPdf(bytes)) {
    return { kind: 'pdf', contentType: 'application/pdf', bytes }
  }
  if (!isSupportedTextContentType(contentType)) {
    throw new WebPageError(`暂不支持读取此网页类型（${contentType || '未知类型'}）`)
  }
  return {
    kind: 'text',
    contentType,
    text: decodeWebDocument(bytes, declaredType.charset, contentType),
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new WebPageError('目标网页超过安全大小限制')
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > maxBytes) {
        await reader.cancel()
        throw new WebPageError('目标网页超过安全大小限制')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function decodeWebDocument(
  bytes: Uint8Array,
  headerCharset: string | null,
  contentType: string,
): string {
  const charset = headerCharset
    ?? bomCharset(bytes)
    ?? (isHtmlContentType(contentType) ? htmlMetaCharset(bytes) : null)
    ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder().decode(bytes)
  }
}

function htmlMetaCharset(bytes: Uint8Array): string | null {
  const probe = new TextDecoder('windows-1252').decode(bytes.subarray(0, 2_048))
  return probe.match(/<meta[^>]+charset\s*=\s*["']?\s*([^\s"'/>;]+)/iu)?.[1]?.trim() ?? null
}

function bomCharset(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8'
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le'
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be'
  return null
}

function parseContentType(value: string | null): { mediaType: string | null; charset: string | null } {
  if (!value) return { mediaType: null, charset: null }
  const [rawMediaType = '', ...parameters] = value.split(';')
  const mediaType = rawMediaType.trim().toLowerCase() || null
  const charset = parameters
    .map((part) => part.match(/^\s*charset\s*=\s*["']?([^\s"']+)["']?\s*$/iu)?.[1] ?? null)
    .find((part): part is string => Boolean(part))
    ?? null
  return { mediaType, charset }
}

function sniffContentType(bytes: Uint8Array): string {
  if (isPdf(bytes)) return 'application/pdf'
  if (bytes.subarray(0, 512).includes(0)) return 'application/octet-stream'
  const probe = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  return /<!doctype\s+html|<(?:html|head|body|title|main)(?:\s|>)/u.test(probe)
    ? 'text/html'
    : 'text/plain'
}

function isSupportedTextContentType(value: string): boolean {
  return [
    'application/xhtml+xml',
    'text/html',
    'text/markdown',
    'text/plain',
    'text/x-markdown',
  ].includes(value)
}

function isPdf(bytes: Uint8Array): boolean {
  return new TextDecoder('ascii').decode(bytes.subarray(0, 1_024)).includes('%PDF-')
}

export function isHtmlContentType(value: string): boolean {
  return value === 'text/html' || value === 'application/xhtml+xml'
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

function redirectUrl(location: string, currentUrl: URL): URL {
  try {
    const nextUrl = parseWebPageUrl(new URL(location, currentUrl).toString())
    if (currentUrl.protocol === 'https:' && nextUrl.protocol !== 'https:') {
      throw new WebPageError('目标网站尝试从 HTTPS 重定向到不安全的 HTTP 地址')
    }
    return nextUrl
  } catch (error) {
    if (error instanceof WebPageError) throw error
    throw new WebPageError('目标网站返回了无效的重定向地址')
  }
}

function httpStatusError(status: number): WebPageError {
  if (status === 401 || status === 403) return new WebPageError('目标网页需要登录或拒绝访问')
  if (status === 404) return new WebPageError('目标网页不存在（HTTP 404）')
  if (status === 408 || status === 504) return new WebPageError('目标网站响应超时')
  if (status === 429) return new WebPageError('目标网站请求过于频繁（HTTP 429）')
  if (status >= 500) return new WebPageError(`目标网站暂时不可用（HTTP ${status}）`)
  return new WebPageError(`目标网页读取失败（HTTP ${status}）`)
}
