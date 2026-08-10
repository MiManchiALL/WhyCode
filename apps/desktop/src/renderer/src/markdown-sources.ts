export type SourceKind = 'git' | 'document' | 'web'

export interface MarkdownSource {
  title: string
  url: string
  domain: string
  kind: SourceKind
}

interface ElementNode {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: unknown[]
}

interface TextNode {
  type: 'text'
  value: string
}

export function isExternalSourceList(node: unknown): boolean {
  return externalSourcesFromList(node) !== null
}

export function externalSourcesFromList(node: unknown): MarkdownSource[] | null {
  if (!isElement(node, 'ul')) return null
  const items = meaningfulChildren(node)
  if (items.length === 0) return null

  const sources = items.map(sourceFromListItem)
  return sources.every((source): source is MarkdownSource => source !== null) ? sources : null
}

export function isInlineSourceLabel(label: string): boolean {
  return ['来源', 'source'].includes(label.trim().toLowerCase())
}

export function normalizeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function sourceKindForUrl(value: string): SourceKind {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  if (['github.com', 'gitlab.com', 'bitbucket.org'].includes(hostname)) return 'git'
  if (
    /\.(?:pdf|docx?|pptx?|xlsx?)$/iu.test(url.pathname)
    || ['arxiv.org', 'doi.org', 'aclanthology.org'].includes(hostname)
  ) return 'document'
  return 'web'
}

/** 正文引用与末尾来源可能由不同 Markdown block 渲染，统一在所属回答内定位。 */
export function findSourceCapsule(root: Element, url: string): HTMLElement | null {
  const scope = root.closest('[data-source-scope]') ?? root
  return [...scope.querySelectorAll<HTMLElement>('[data-source-capsule-url]')]
    .find((candidate) => candidate.dataset.sourceCapsuleUrl === url) ?? null
}

function sourceFromListItem(node: unknown): MarkdownSource | null {
  if (!isElement(node, 'li')) return null
  let children = meaningfulChildren(node)
  if (children.length === 1 && isElement(children[0], 'p')) {
    children = meaningfulChildren(children[0])
  }
  if (children.length !== 1 || !isElement(children[0], 'a')) return null
  const url = normalizeSourceUrl(children[0].properties?.href)
  if (!url) return null
  const parsed = new URL(url)
  return {
    title: textContent(children[0]).trim() || parsed.hostname,
    url,
    domain: parsed.hostname.replace(/^www\./iu, ''),
    kind: sourceKindForUrl(url),
  }
}

function textContent(node: unknown): string {
  if (isText(node)) return node.value
  if (!isRecord(node) || !Array.isArray(node.children)) return ''
  return node.children.map(textContent).join('')
}

function meaningfulChildren(node: ElementNode): unknown[] {
  return (node.children ?? []).filter((child) => !isWhitespace(child))
}

function isWhitespace(node: unknown): boolean {
  return isText(node) && node.value.trim() === ''
}

function isElement(node: unknown, tagName: string): node is ElementNode {
  return isRecord(node) && node.type === 'element' && node.tagName === tagName
}

function isText(node: unknown): node is TextNode {
  return isRecord(node) && node.type === 'text' && typeof node.value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
