import {
  WEB_FETCH_MAX_LINES,
  WEB_FETCH_MAX_OUTPUT_CHARS,
  WEB_FIND_MAX_OUTPUT_CHARS,
  WebPageError,
  type WebFetchHandler,
  type WebFetchPdfResponse,
  type WebFetchResponse,
  type WebFindHandler,
  type WebFindMatch,
  type PdfAttachment,
} from '@whycode/core'
import type { ExtractedWebPage } from './content.ts'
import { parseWebPageUrl } from './url-safety.ts'
import type { WebDocument, WebPdfDocument, WebTextDocument } from './network.ts'

export const WEB_PAGE_CACHE_MAX_ENTRIES = 6
export const WEB_PAGE_CACHE_TTL_MS = 15 * 60_000

export interface WebPageReader {
  fetchPage: WebFetchHandler
  findInPage: WebFindHandler
}

export interface WebPageReaderOptions {
  fetchDocument: (url: string, abortSignal: AbortSignal) => Promise<WebDocument>
  extractDocument: (
    document: WebTextDocument,
    abortSignal: AbortSignal,
  ) => Promise<ExtractedWebPage>
  importPdfDocument: (
    document: WebPdfDocument,
    abortSignal: AbortSignal,
  ) => Promise<PdfAttachment>
  now?: () => number
  cacheTtlMs?: number
  maxEntries?: number
}

interface CacheEntry {
  page: ExtractedWebPage
  expiresAt: number
}

type LoadedResource =
  | { kind: 'page'; page: ExtractedWebPage }
  | { kind: 'pdf'; response: WebFetchPdfResponse }

export function createWebPageReader(options: WebPageReaderOptions): WebPageReader {
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<LoadedResource>>()
  const now = options.now ?? Date.now
  const cacheTtlMs = options.cacheTtlMs ?? WEB_PAGE_CACHE_TTL_MS
  const maxEntries = options.maxEntries ?? WEB_PAGE_CACHE_MAX_ENTRIES

  const fetchPage: WebFetchHandler = async (request, abortSignal) => {
    const requestedUrl = parseWebPageUrl(request.url).toString()
    let page = getCachedPage(cache, requestedUrl, now())
    if (!page) {
      const loaded = await loadResource(requestedUrl, abortSignal)
      if (loaded.kind === 'pdf') return loaded.response
      page = loaded.page
    }
    return pageSlice(
      page,
      request.offset ?? 1,
      request.limit ?? WEB_FETCH_MAX_LINES,
    )
  }

  const findInPage: WebFindHandler = async (request, abortSignal) => {
    const requestedUrl = parseWebPageUrl(request.url).toString()
    const page = getCachedPage(cache, requestedUrl, now())
    if (!page) {
      throw new WebPageError('当前会话没有这个文本网页的有效缓存；请先使用 WebFetch 读取同一 URL，若结果是 PDF 则改用 ReadPdf')
    }
    const pattern = request.pattern.toLowerCase()
    const matches: WebFindMatch[] = []
    let outputChars = 0

    for (let index = 0; index < page.lines.length; index++) {
      if (index % 256 === 0 && abortSignal.aborted) {
        throw new WebPageError('网页查找已取消')
      }
      const line = page.lines[index]!
      if (!line.toLowerCase().includes(pattern)) continue
      const context = contextWithinBudget(
        page.lines,
        index,
        request.context,
        WEB_FIND_MAX_OUTPUT_CHARS - outputChars,
      )
      if (context.length === 0) break
      const contextChars = context.reduce((total, item) => total + item.text.length, 0)
      matches.push({ lineNumber: index + 1, context })
      outputChars += contextChars
      if (matches.length >= request.maxResults || outputChars >= WEB_FIND_MAX_OUTPUT_CHARS) break
    }

    return {
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      ...(page.title ? { title: page.title } : {}),
      totalLines: page.lines.length,
      matches,
    }
  }

  async function loadResource(url: string, abortSignal: AbortSignal): Promise<LoadedResource> {
    const existing = inFlight.get(url)
    if (existing) return existing
    const pending = options.fetchDocument(url, abortSignal).then(async (document) => {
      if (abortSignal.aborted) throw new WebPageError('网页读取已取消')
      if (document.kind === 'pdf') {
        const attachment = await options.importPdfDocument(document, abortSignal)
        return {
          kind: 'pdf' as const,
          response: {
            kind: 'pdf' as const,
            requestedUrl: document.requestedUrl,
            finalUrl: document.finalUrl,
            contentType: 'application/pdf' as const,
            attachment,
          },
        }
      }
      const page = await options.extractDocument(document, abortSignal)
      putCachedPage(cache, url, page, now() + cacheTtlMs, maxEntries)
      return { kind: 'page' as const, page }
    })
    inFlight.set(url, pending)
    try {
      return await pending
    } finally {
      if (inFlight.get(url) === pending) inFlight.delete(url)
    }
  }

  return { fetchPage, findInPage }
}

function pageSlice(
  page: ExtractedWebPage,
  offset: number,
  limit: number,
): WebFetchResponse {
  const lines: string[] = []
  let outputChars = 0
  for (let index = offset - 1; index < page.lines.length && lines.length < limit; index++) {
    const line = page.lines[index]!
    if (lines.length > 0 && outputChars + line.length > WEB_FETCH_MAX_OUTPUT_CHARS) break
    lines.push(line)
    outputChars += line.length
  }
  return {
    kind: 'page',
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    ...(page.title ? { title: page.title } : {}),
    contentType: page.contentType,
    offset,
    totalLines: page.lines.length,
    lines,
    sourceTruncated: page.sourceTruncated,
  }
}

function contextWithinBudget(
  lines: readonly string[],
  matchIndex: number,
  contextLines: number,
  budget: number,
): { lineNumber: number; text: string }[] {
  const match = lines[matchIndex]!
  if (match.length > budget) return []
  const selected = new Map<number, string>([[matchIndex, match]])
  let used = match.length
  for (let distance = 1; distance <= contextLines; distance++) {
    for (const index of [matchIndex - distance, matchIndex + distance]) {
      const line = lines[index]
      if (line === undefined || used + line.length > budget) continue
      selected.set(index, line)
      used += line.length
    }
  }
  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, text]) => ({ lineNumber: index + 1, text }))
}

function getCachedPage(
  cache: Map<string, CacheEntry>,
  url: string,
  currentTime: number,
): ExtractedWebPage | null {
  const exact = cache.get(url)
  const found = exact
    ? { key: url, entry: exact }
    : [...cache.entries()]
        .map(([key, entry]) => ({ key, entry }))
        .find(({ entry }) => entry.page.finalUrl === url)
  if (!found) return null
  if (found.entry.expiresAt <= currentTime) {
    cache.delete(found.key)
    return null
  }
  // Map 的插入顺序同时承担 LRU；命中后移到末尾。
  cache.delete(found.key)
  cache.set(found.key, found.entry)
  return found.entry.page
}

function putCachedPage(
  cache: Map<string, CacheEntry>,
  key: string,
  page: ExtractedWebPage,
  expiresAt: number,
  maxEntries: number,
): void {
  cache.delete(key)
  cache.set(key, { page, expiresAt })
  while (cache.size > Math.max(1, maxEntries)) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cache.delete(oldest)
  }
}
