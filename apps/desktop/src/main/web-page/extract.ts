import { Readability } from '@mozilla/readability'
import { WEB_PAGE_MAX_URL_CHARS } from '@whycode/core'
import { parseHTML } from 'linkedom'
import { NodeHtmlMarkdown } from 'node-html-markdown'
import { createExtractedWebPage, type WebPageExtraction } from './content.ts'
import { isHtmlContentType, type WebTextDocument } from './network.ts'
import { pageMarkdownUrl } from './url-safety.ts'

interface HtmlElement {
  innerHTML: string
  textContent: string | null
  parentElement: HtmlElement | null
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
  textReplace: [[/(?<=[\p{L}\p{N}])\\_(?=[\p{L}\p{N}])/gu, '_']],
  useInlineLinks: true,
})

export function extractWebPage(source: WebTextDocument): WebPageExtraction {
  if (!isHtmlContentType(source.contentType)) {
    return createExtractedWebPage(source, source.text, { title: cleanTitle(source.title) })
  }
  const { document } = parseHTML(source.text) as unknown as { document: HtmlDocument }
  const fallbackTitle = cleanTitle(document.title)
  const markdownUrl = findMarkdownAlternate(document, source.finalUrl)
  sanitizeDocument(document, source.finalUrl)

  const article = new Readability(
    document.cloneNode(true) as unknown as ConstructorParameters<typeof Readability>[0],
    { charThreshold: 100, keepClasses: false },
  ).parse()
  const content = article?.content?.trim() || fallbackContent(document)
  const title = cleanTitle(article?.title) || fallbackTitle
  return {
    ...createExtractedWebPage(source, content ? markdownConverter.translate(content) as string : '', { title }),
    ...(markdownUrl ? { markdownUrl } : {}),
  }
}

function findMarkdownAlternate(document: HtmlDocument, pageUrl: string): string | undefined {
  const base = document.querySelectorAll('head > base[href]')[0]?.getAttribute('href')
  const baseUrl = base ? URL.parse(base, pageUrl)?.href ?? pageUrl : pageUrl
  for (const link of document.querySelectorAll('head > link[rel][type][href]')) {
    if (!link.getAttribute('rel')?.toLowerCase().split(/\s+/u).includes('alternate')
      || !/^text\/(?:x-)?markdown(?:\s*;|$)/iu.test(link.getAttribute('type')?.trim() ?? '')) continue
    const url = pageMarkdownUrl(link.getAttribute('href'), pageUrl, baseUrl)
    if (url) return url
  }
}

function sanitizeDocument(document: HtmlDocument, baseUrl: string): void {
  for (const element of document.querySelectorAll(REMOVED_ELEMENTS)) element.remove()
  retainReachablePanels(document)
  for (const button of document.querySelectorAll('button')) button.remove()
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? ''
    const url = href.length <= WEB_PAGE_MAX_URL_CHARS ? URL.parse(href, baseUrl) : null
    if (href && url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
      anchor.setAttribute('href', url.href)
    } else {
      anchor.removeAttribute('href')
    }
  }
}

function retainReachablePanels(document: HtmlDocument): void {
  const panels = new Set<string>()
  const tabs = new Set<string>()
  const isPanel = (element: HtmlElement) => panels.has(element.getAttribute('id') ?? '') ||
    (element.getAttribute('role') === 'tabpanel' &&
      element.getAttribute('aria-labelledby')?.split(/\s+/u).some((id) => tabs.has(id)))
  for (const control of document.querySelectorAll('button[aria-controls], [role="button"][aria-controls], [role="tab"], [aria-expanded][aria-controls]')) {
    if (control.getAttribute('disabled') !== null) continue
    let ancestor: HtmlElement | null = control
    while (ancestor && (!isHidden(ancestor) || isPanel(ancestor))) ancestor = ancestor.parentElement
    if (ancestor) continue
    for (const id of control.getAttribute('aria-controls')?.match(/\S+/gu) ?? []) panels.add(id)
    const id = control.getAttribute('id')
    if (id && control.getAttribute('role') === 'tab') tabs.add(id)
  }
  for (const element of document.querySelectorAll('[hidden], [aria-hidden="true"], [style]')) {
    if (!isHidden(element)) continue
    if (isPanel(element)) {
      element.removeAttribute('hidden')
      element.removeAttribute('aria-hidden')
      element.removeAttribute('style')
    } else {
      element.remove()
    }
  }
}

function isHidden(element: HtmlElement): boolean {
  return element.getAttribute('hidden') !== null || element.getAttribute('aria-hidden') === 'true'
    || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(element.getAttribute('style') ?? '')
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

function textLength(element: HtmlElement | null): number {
  return element?.textContent?.trim().length ?? 0
}
