import { Readability } from '@mozilla/readability'
import { WEB_PAGE_MAX_LINE_CHARS, WEB_PAGE_MAX_URL_CHARS } from '@whycode/core'
import { parseHTML } from 'linkedom'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import { isHtmlContentType, type WebDocument } from './network.ts'

export const WEB_PAGE_MAX_CONTENT_CHARS = 250_000

export interface ExtractedWebPage {
  requestedUrl: string
  finalUrl: string
  title?: string
  contentType: string
  lines: readonly string[]
  sourceTruncated: boolean
}

interface HtmlElement {
  innerHTML: string
  textContent: string | null
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  remove(): void
}

interface HtmlDocument {
  title: string
  body: HtmlElement | null
  cloneNode(deep: boolean): HtmlDocument
  querySelectorAll(selector: string): HtmlElement[]
}

const REMOVED_ELEMENTS = [
  'audio',
  'button',
  'canvas',
  'embed',
  'form',
  'iframe',
  'img',
  'input',
  'noscript',
  'object',
  'picture',
  'script',
  'select',
  'source',
  'style',
  'svg',
  'template',
  'textarea',
  'video',
].join(',')

const markdownConverter = new NodeHtmlMarkdown({
  bulletMarker: '-',
  codeBlockStyle: 'fenced',
  keepDataImages: false,
  maxConsecutiveNewlines: 2,
  useInlineLinks: true,
})

export function extractWebPage(document: WebDocument): ExtractedWebPage {
  const extracted = isHtmlContentType(document.contentType)
    ? extractHtml(document.text, document.finalUrl)
    : { markdown: document.text }
  const bounded = toBoundedLines(extracted.markdown)
  return {
    requestedUrl: document.requestedUrl,
    finalUrl: document.finalUrl,
    ...(extracted.title ? { title: extracted.title } : {}),
    contentType: document.contentType,
    lines: bounded.lines,
    sourceTruncated: bounded.truncated,
  }
}

function extractHtml(html: string, baseUrl: string): { title?: string; markdown: string } {
  const { document } = parseHTML(html) as unknown as { document: HtmlDocument }
  const fallbackTitle = cleanTitle(document.title)
  sanitizeDocument(document, baseUrl)

  const article = new Readability(
    document.cloneNode(true) as unknown as ConstructorParameters<typeof Readability>[0],
    { charThreshold: 100, keepClasses: false },
  ).parse()
  const fallback = fallbackContent(document)
  const content = article?.content?.trim() || fallback
  const title = cleanTitle(article?.title) || fallbackTitle
  return {
    ...(title ? { title } : {}),
    markdown: content ? markdownConverter.translate(content) as string : '',
  }
}

function sanitizeDocument(document: HtmlDocument, baseUrl: string): void {
  for (const element of document.querySelectorAll(REMOVED_ELEMENTS)) element.remove()
  for (const element of document.querySelectorAll('[hidden], [aria-hidden="true"]')) {
    element.remove()
  }
  for (const element of document.querySelectorAll('[style]')) {
    const style = element.getAttribute('style') ?? ''
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(style)) element.remove()
  }
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')
    if (!href) continue
    if (href.length > WEB_PAGE_MAX_URL_CHARS) {
      anchor.removeAttribute('href')
      continue
    }
    try {
      const resolved = new URL(href, baseUrl)
      if (
        !['http:', 'https:'].includes(resolved.protocol)
        || resolved.username
        || resolved.password
      ) {
        anchor.removeAttribute('href')
      } else {
        anchor.setAttribute('href', resolved.toString())
      }
    } catch {
      anchor.removeAttribute('href')
    }
  }
}

function fallbackContent(document: HtmlDocument): string {
  const clone = document.cloneNode(true)
  for (const element of clone.querySelectorAll('aside, footer, nav')) element.remove()
  const candidates = [...clone.querySelectorAll('article, main, [role="main"]')]
    .filter((element, index, all) => all.indexOf(element) === index)
  const candidate = candidates.reduce<HtmlElement | null>((best, element) =>
    textLength(element) > textLength(best) ? element : best, null)
    ?? clone.body
  return candidate?.innerHTML?.trim() ?? ''
}

function toBoundedLines(markdown: string): { lines: string[]; truncated: boolean } {
  const normalized = markdown
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim()
  if (!normalized) return { lines: [], truncated: false }

  const lines: string[] = []
  let totalChars = 0
  let blankLines = 0
  let truncated = false
  outer: for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) {
      if (blankLines >= 1) continue
      blankLines++
    } else {
      blankLines = 0
    }
    for (const part of splitLongLine(line)) {
      const addedChars = part.length + (lines.length > 0 ? 1 : 0)
      if (totalChars + addedChars > WEB_PAGE_MAX_CONTENT_CHARS) {
        const available = WEB_PAGE_MAX_CONTENT_CHARS - totalChars - (lines.length > 0 ? 1 : 0)
        if (available > 0) lines.push(safePrefix(part, available))
        truncated = true
        break outer
      }
      lines.push(part)
      totalChars += addedChars
    }
  }
  while (lines.at(-1) === '') lines.pop()
  return { lines, truncated }
}

function splitLongLine(line: string): string[] {
  if (line.length <= WEB_PAGE_MAX_LINE_CHARS) return [line]
  const parts: string[] = []
  let offset = 0
  while (offset < line.length) {
    const part = safePrefix(line.slice(offset), WEB_PAGE_MAX_LINE_CHARS)
    parts.push(part)
    offset += part.length
  }
  return parts
}

function safePrefix(value: string, maxCodeUnits: number): string {
  let end = Math.min(value.length, maxCodeUnits)
  if (
    end > 0
    && end < value.length
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end--
  return value.slice(0, end)
}

function cleanTitle(value: string | null | undefined): string {
  return value?.replace(/\s+/gu, ' ').trim().slice(0, 500) ?? ''
}

function textLength(element: HtmlElement | null): number {
  return element?.textContent?.trim().length ?? 0
}
