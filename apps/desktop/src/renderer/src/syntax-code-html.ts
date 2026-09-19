import type { FileDiffLine } from './file-change-presentation.ts'
import type { HighlightedLines } from './syntax-highlighting.ts'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '\r': '&#13;',
}

/** 同时用于源码文本和带引号的属性，HTML 文件只能作为代码显示。 */
export function escapeCodeHtml(text: string): string {
  return text.replace(/[&<>"'\r]/g, char => HTML_ESCAPES[char]!)
}

export function renderCodeLines(
  lines: readonly FileDiffLine[],
  highlighted: HighlightedLines | null,
  focusLine: number | null,
): string {
  if (lines.length === 0) return '<div class="px-3 py-6 text-center text-[var(--wc-faint)]">空文件</div>'
  const rows = lines.map((line, index) => {
    const displayLine = line.kind === 'removed' ? line.oldLine : line.newLine
    const focus = focusLine !== null && line.kind !== 'removed' && line.newLine === focusLine
    const focusAttribute = focus ? ` data-focus-line="${escapeCodeHtml(String(focusLine))}"` : ''
    return `<div class="wc-code-line flex min-w-full" data-tone="${escapeCodeHtml(line.kind)}"${focusAttribute}>`
      + `<span class="wc-code-line-number sticky left-0 w-14 shrink-0 select-none pr-3 text-right tabular-nums">${escapeCodeHtml(String(displayLine ?? ''))}</span>`
      + `<code class="wc-code-text block min-w-0 flex-1 pr-5">${highlighted?.[index] || escapeCodeHtml(line.text || ' ')}</code></div>`
  })
  // 逐行隔离会阻止 Chromium 合并固定行号的图层；分组仍跳过离屏布局。
  const chunks: string[] = []
  for (let offset = 0; offset < rows.length; offset += 64) {
    const chunk = rows.slice(offset, offset + 64)
    chunks.push(`<div class="wc-code-chunk" style="--wc-code-chunk-lines:${chunk.length}">${chunk.join('')}</div>`)
  }
  return chunks.join('')
}
