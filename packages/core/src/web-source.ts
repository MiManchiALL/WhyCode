export const WEB_SOURCE_CITATION_MARKER = 'whycode:source'

export interface WebSource {
  title: string
  url: string
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

export function markdownWebSource(title: string | undefined, url: string): string {
  const label = escapeMarkdownLabel(title?.trim() || new URL(url).hostname)
  return `[${label}](<${url}> "${WEB_SOURCE_CITATION_MARKER}")`
}

export function markdownWebLineCitation(
  title: string | undefined,
  url: string,
  startLine: number,
  endLine: number,
): string {
  return `${markdownWebSource(title, url)}（L${startLine}-L${endLine}）`
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
}
