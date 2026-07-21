export const WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT =
  '强制要求：最终回答只要使用了网页事实，结尾就必须包含“来源：”段落，并逐条使用“- [标题](URL)”列出实际采用的来源；不得只写裸 URL，也不得省略。工具给出 Lx-Ly 时，正文引用必须保留对应证据范围。'

export function appendWebSourceFinalResponseReminder(content: string): string {
  return `${content.trimEnd()}\n\n${WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT}`
}

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
