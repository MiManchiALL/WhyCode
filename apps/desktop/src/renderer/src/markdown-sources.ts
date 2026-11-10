import { normalizeSourceUrl, WEB_SOURCE_CITATION_MARKER, type WebSource } from '@whycode/core/web-source'
import type { Definition, Link, LinkReference, Nodes, Root } from 'mdast'
import type { Nodes as HtmlNodes, Properties, Root as HtmlRoot } from 'hast'
import { toString } from 'mdast-util-to-string'
import type { Plugin } from 'unified'
import { markdownFileTarget } from './markdown-file-links.ts'

export type SourceKind = 'git' | 'document' | 'web'

export interface SourceCitation {
  node: Link | LinkReference
  source: WebSource
  definition?: Definition
}

function* markdownLinks(tree: Root) {
  const definitions = new Map<string, Definition>()
  for (const node of nodes(tree)) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
  }
  for (const node of nodes(tree)) {
    if (node.type !== 'link' && node.type !== 'linkReference') continue
    const definition = node.type === 'linkReference' ? definitions.get(node.identifier) : undefined
    const target = node.type === 'link' ? node : definition
    if (target) yield { node, target, definition }
  }
}

function linkSource(node: Link | LinkReference, target: Link | Definition): WebSource | null {
  if (target.title !== WEB_SOURCE_CITATION_MARKER) return null
  const url = normalizeSourceUrl(target.url)
  const title = toString(node).replace(/\s+/gu, ' ').trim()
  return url && title ? { url, title } : null
}

/** 汇总和渲染共用语法树中的显式链接标记，不扫描代码、HTML 或链接文字。 */
export function sourceCitations(tree: Root): SourceCitation[] {
  const citations: SourceCitation[] = []
  for (const { node, target, definition } of markdownLinks(tree)) {
    const source = linkSource(node, target)
    if (source) citations.push({ node, source, ...(definition ? { definition } : {}) })
  }
  return citations
}

export const remarkResponseLinks: Plugin<[{ files?: boolean }?], Root> = (options) => (tree, file) => {
  const links = new Map<number, Properties>()
  for (const { node, target } of markdownLinks(tree)) {
    const offset = node.position?.start.offset
    if (offset === undefined) continue
    const source = linkSource(node, target)
    if (source) {
      links.set(offset, { 'data-source-citation-url': source.url })
    } else if (options?.files) {
      const reference = markdownFileTarget(target.url)
      if (!reference) continue
      // Streamdown 会把相对路径解析成网站根路径，并拦截盘符。文件只由预览按钮打开。
      node.data ??= {}
      node.data.hProperties = { ...node.data.hProperties, href: '#workspace-file' }
      links.set(offset, { 'data-file-path': reference.path, 'data-file-line': reference.line, 'data-file-end-line': reference.endLine })
    }
  }
  file.data.whycodeResponseLinks = links
}

/** 清洗后只给同一位置的 Markdown 链接补属性，原始 HTML 不能伪造文件或来源。 */
export const rehypeResponseLinks: Plugin<[], HtmlRoot> = () => (tree, file) => {
  const links = file.data.whycodeResponseLinks as Map<number, Properties>
  for (const node of nodes(tree)) {
    if (node.type !== 'element' || node.tagName !== 'a') continue
    const start = node.position?.start.offset
    const properties = start === undefined ? undefined : links.get(start)
    if (properties) Object.assign(node.properties, properties)
  }
}

function* nodes(node: Nodes | HtmlNodes): Generator<Nodes | HtmlNodes> {
  yield node
  if ('children' in node) {
    for (const child of node.children) {
      yield* nodes(child)
    }
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
