export const WEB_SOURCE_CITATION_MARKER = 'whycode:source'

export interface WebSource {
  title: string
  url: string
}

export const WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT =
  '仅当最终交付是调研、搜索、资料汇总或事实比较时引用来源；执行任务的中间查证不列来源。'
  + `关键结论附近使用 [实际来源标题](实际URL "${WEB_SOURCE_CITATION_MARKER}")；可直接复用网页工具返回的引用链接，保留末尾的引用标记。`
  + '每处引用同时给出真实标题与完整 HTTP(S) URL，界面自动显示引用图标并汇总末尾来源胶囊。普通的官网、控制台等操作链接不带引用标记。'
  + '来源无需调用 Present，也不要另写末尾来源列表。'

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

export function appendWebSourceFinalResponseReminder(content: string): string {
  return `${content.trimEnd()}\n\n${WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT}`
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
