import { normalizeSourceUrl, WEB_SOURCE_CITATION_MARKER, type WebSource } from '@whycode/core/web-source'
import type { Definition, Link, LinkReference, Nodes, Root } from 'mdast'
import type { Nodes as HtmlNodes, Root as HtmlRoot } from 'hast'
import { toString } from 'mdast-util-to-string'
import type { Plugin } from 'unified'

export type SourceKind = 'git' | 'document' | 'web'

export interface SourceCitation {
  node: Link | LinkReference
  source: WebSource
  definition?: Definition
}

/** 汇总和渲染共用语法树中的显式链接标记，不扫描代码、HTML 或链接文字。 */
export function sourceCitations(tree: Root): SourceCitation[] {
  const definitions = new Map<string, Definition>()
  for (const node of nodes(tree)) {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node)
  }
  const citations: SourceCitation[] = []
  for (const node of nodes(tree)) {
    if (node.type !== 'link' && node.type !== 'linkReference') continue
    const definition = node.type === 'linkReference' ? definitions.get(node.identifier) : undefined
    const target = node.type === 'link' ? node : definition
    if (target?.title !== WEB_SOURCE_CITATION_MARKER) continue
    const url = normalizeSourceUrl(target.url)
    const title = toString(node).replace(/\s+/gu, ' ').trim()
    if (url && title) citations.push({ node, source: { title, url }, ...(definition ? { definition } : {}) })
  }
  return citations
}

export const remarkSourceCitations: Plugin<[], Root> = () => (tree, file) => {
  file.data.whycodeSourceCitations = new Map(sourceCitations(tree).flatMap(({ node, source }) =>
    node.position ? [[node.position.start.offset, source.url]] : []))
}

/** 在安全清洗之后标注实际 Markdown 链接，HTML 不能伪造引用属性。 */
export const rehypeSourceCitations: Plugin<[], HtmlRoot> = () => (tree, file) => {
  const citations = file.data.whycodeSourceCitations as Map<number, string>
  for (const node of nodes(tree)) {
    if (node.type !== 'element' || node.tagName !== 'a') continue
    const start = node.position?.start.offset
    const url = start === undefined ? undefined : citations.get(start)
    if (url) node.properties['data-source-citation-url'] = url
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
