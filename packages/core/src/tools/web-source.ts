export const WEB_SOURCE_FINAL_RESPONSE_REQUIREMENT =
  '最终回答的网页引用规则：仅当当前用户请求的最终交付物是调研、搜索、资料汇总或事实比较时，才标注来源；联网若只是执行、修改代码或生成产物前的中间查证，不输出正文引用和来源列表。需要来源时，只在关键结论句末使用“[来源](实际URL)”，不要逐句或为常识堆叠引用；正文每个“[来源](实际URL)”的 URL 都必须在回答末尾的来源列表中原样出现一次。把去重后的“- [标题](实际URL)”列表放在最后一节“### 来源”中，且该节必须是回答末尾。不要使用裸 URL 或脱离实际 URL 的编号占位引用。'

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
