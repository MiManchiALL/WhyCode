export function markdownWebSource(title: string | undefined, url: string): string {
  const label = escapeMarkdownLabel(title?.trim() || new URL(url).hostname)
  return `[${label}](<${url}>)`
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
