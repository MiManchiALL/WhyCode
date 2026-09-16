export const WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT =
  '仅当最终交付是调研、搜索、资料汇总或事实比较时引用来源；执行任务的中间查证不列来源。关键结论句末使用 [来源](实际URL)，最终回答前用 Present 声明对应 sources；不要另写末尾来源列表。'

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
