import type { PresentedSource } from '@whycode/core/presentation'

export type SourceKind = 'git' | 'document' | 'web'

export function findPresentedSource(sources: readonly PresentedSource[] | undefined, href: unknown): PresentedSource | undefined {
  const url = normalizeSourceUrl(href)
  return url ? sources?.find(source => normalizeSourceUrl(source.url) === url) : undefined
}

export function normalizeSourceUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
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
