import { Readability } from '@mozilla/readability'
import { WEB_PAGE_MAX_URL_CHARS } from '@whycode/core'
import { parseHTML } from 'linkedom'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import { createExtractedWebPage, type ExtractedWebPage } from './content.ts'
import { isHtmlContentType, type WebTextDocument } from './network.ts'

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

export function extractWebPage(document: WebTextDocument): ExtractedWebPage {
  const extracted = isHtmlContentType(document.contentType)
    ? extractHtml(document.text, document.finalUrl)
    : { markdown: document.text }
  return createExtractedWebPage(document, extracted.markdown, {
    ...(extracted.title ? { title: extracted.title } : {}),
  })
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

function cleanTitle(value: string | null | undefined): string {
  return value?.replace(/\s+/gu, ' ').trim().slice(0, 500) ?? ''
}

export type { ExtractedWebPage } from './content.ts'

function textLength(element: HtmlElement | null): number {
  return element?.textContent?.trim().length ?? 0
}
