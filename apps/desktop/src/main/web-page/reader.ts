import {
  WEB_FETCH_MAX_LINES,
  WEB_FETCH_MAX_OUTPUT_CHARS,
  normalizeWebFindText,
  WebPageError,
  type WebFetchPdfResponse,
  type WebFetchResponse,
  type WebFindRequest,
  type WebPageLine,
  type WebPageReader,
  type PdfAttachment,
} from '@whycode/core'
import { createExtractedWebPage, type ExtractedWebPage, type WebPageExtraction } from './content.ts'
import { parseWebPageUrl } from './url-safety.ts'
import type { WebDocument, WebPdfDocument, WebTextDocument } from './network.ts'

export const WEB_PAGE_CACHE_MAX_ENTRIES = 6
export const WEB_PAGE_CACHE_TTL_MS = 15 * 60_000

export interface WebPageReaderOptions {
  fetchDocument: (url: string, abortSignal: AbortSignal) => Promise<WebDocument>
  fetchLinkedMarkdown: (url: string, pageUrl: string, abortSignal: AbortSignal) => Promise<WebTextDocument | null>
  extractDocument: (
    document: WebTextDocument,
    abortSignal: AbortSignal,
  ) => Promise<WebPageExtraction>
  importPdfDocument: (
    document: WebPdfDocument,
    abortSignal: AbortSignal,
  ) => Promise<PdfAttachment>
  now?: () => number
  cacheTtlMs?: number
  maxEntries?: number
}

interface CacheEntry {
  documentUrl: string
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

  const fetchPage: WebPageReader['fetchPage'] = async (request, abortSignal) => {
    const requestedUrl = parseWebPageUrl(request.url).toString()
    let page = getCachedPage(cache, requestedUrl, now())
    if (!page) {
      const loaded = await loadResource(requestedUrl, abortSignal)
      if (loaded.kind === 'pdf') return loaded.response
      page = loaded.page
    }
    return pageSlice(
      page,
      requestedUrl,
      request.offset ?? 1,
      request.limit ?? WEB_FETCH_MAX_LINES,
    )
  }

  const findInPage: WebPageReader['findInPage'] = async (request, abortSignal) => {
    const requestedUrl = parseWebPageUrl(request.url).toString()
    const page = getCachedPage(cache, requestedUrl, now())
    if (!page) {
      throw new WebPageError('当前会话没有该网页的有效正文缓存。请先用同一 url 和 limit=1 读取；若为 PDF，请用 ReadFile。')
    }
    return {
      requestedUrl,
      finalUrl: page.finalUrl,
      title: page.title,
      totalLines: page.lines.length,
      ...findMatchingLines(page.lines, request, abortSignal),
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
      const extracted = await options.extractDocument(document, abortSignal)
      let page: ExtractedWebPage = extracted
      if (extracted.markdownUrl) {
        const markdown = await options.fetchLinkedMarkdown(extracted.markdownUrl, document.finalUrl, abortSignal)
        if (markdown) page = createExtractedWebPage(markdown, markdown.text, { title: extracted.title })
      }
      abortSignal.throwIfAborted()
      putCachedPage(cache, url, { documentUrl: document.finalUrl, page, expiresAt: now() + cacheTtlMs }, maxEntries)
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
  requestedUrl: string,
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
    requestedUrl,
    finalUrl: page.finalUrl,
    ...(page.title ? { title: page.title } : {}),
    contentType: page.contentType,
    offset,
    totalLines: page.lines.length,
    lines,
    sourceTruncated: page.sourceTruncated,
  }
}

function findMatchingLines(lines: readonly string[], request: WebFindRequest, signal: AbortSignal) {
  const matches: WebPageLine[] = []
  let chars = 0
  let position = 0
  let hasMore = false
  for (const index of matchingLineIndices(lines, request.patterns, signal)) {
    position++
    if (position < request.offset) continue
    const text = lines[index]!
    if (matches.length === request.maxResults || chars + text.length > WEB_FETCH_MAX_OUTPUT_CHARS) {
      hasMore = true
      break
    }
    matches.push({ lineNumber: index + 1, text })
    chars += text.length
  }
  matches.sort((a, b) => a.lineNumber - b.lineNumber)
  return { matches, hasMore }
}

// 先枚举各关键词的首次命中，再按原文补齐。翻页只依赖这个顺序，与每次能显示几行无关。
function* matchingLineIndices(lines: readonly string[], patterns: readonly string[], signal: AbortSignal) {
  const priority = new Set<number>()
  if (patterns.length > 1) {
    const first = new Map<string, number>()
    for (let index = 0; index < lines.length && first.size < patterns.length; index++) {
      if (index % 256 === 0) signal.throwIfAborted()
      const text = normalizeWebFindText(lines[index]!)
      for (const word of patterns) {
        if (!first.has(word) && text.includes(word)) first.set(word, index)
      }
    }
    if (first.size === 0) return
    for (const word of patterns) {
      const index = first.get(word)
      if (index !== undefined) priority.add(index)
    }
    yield* priority
  }

  for (let index = 0; index < lines.length; index++) {
    if (index % 256 === 0) signal.throwIfAborted()
    if (priority.has(index)) continue
    const text = normalizeWebFindText(lines[index]!)
    if (patterns.some((word) => text.includes(word))) yield index
  }
}

function getCachedPage(
  cache: Map<string, CacheEntry>,
  url: string,
  currentTime: number,
): ExtractedWebPage | null {
  const exact = cache.get(url)
  const found = exact ? [url, exact] as const : [...cache].find(([, { documentUrl, page }]) =>
    documentUrl === url || page.requestedUrl === url || page.finalUrl === url)
  if (!found) return null
  const [key, entry] = found
  cache.delete(key)
  if (entry.expiresAt <= currentTime) return null
  // Map 的插入顺序同时承担 LRU；命中后移到末尾。
  cache.set(key, entry)
  return entry.page
}

function putCachedPage(
  cache: Map<string, CacheEntry>,
  key: string,
  entry: CacheEntry,
  maxEntries: number,
): void {
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > Math.max(1, maxEntries)) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cache.delete(oldest)
  }
}
