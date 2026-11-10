import type { CodeExcerpt } from './code-reference.ts'
import type { FileDiffLine } from './file-change-presentation.ts'

interface CodePoint { row: number; offset: number }
export interface CodeRange { start: CodePoint; end: CodePoint; backward: boolean }

function codePoint(root: HTMLElement, node: Node, offset: number): CodePoint | null {
  const element = node instanceof Element ? node : node.parentElement
  const row = element?.closest<HTMLElement>('[data-code-row]')
  const code = row?.querySelector('code')
  if (!row || !code || !root.contains(row)) return null
  let column = 0
  if (code.contains(node)) {
    const prefix = root.ownerDocument.createRange()
    prefix.selectNodeContents(code)
    prefix.setEnd(node, offset)
    column = prefix.toString().length
  } else if (node === row && offset === row.childNodes.length) column = code.textContent.length
  return { row: Number(row.dataset.codeRow), offset: column }
}

export function readCodeRange(root: HTMLElement): CodeRange | null {
  const selection = root.ownerDocument.getSelection()
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const start = codePoint(root, range.startContainer, range.startOffset)
  const end = codePoint(root, range.endContainer, range.endOffset)
  if (!start || !end) return null
  return { start, end, backward: selection.anchorNode === range.endContainer && selection.anchorOffset === range.endOffset }
}

function domPoint(root: HTMLElement, point: CodePoint): [Node, number] | null {
  const code = root.querySelector(`[data-code-row="${point.row}"] > code`)
  if (!code) return null
  let remaining = point.offset
  const walk = root.ownerDocument.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  for (let node = walk.nextNode(); node; node = walk.nextNode()) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) return [node, remaining]
    remaining -= length
  }
  return [code, code.childNodes.length]
}

export function selectCodeRange(root: HTMLElement, range: CodeRange): void {
  const start = domPoint(root, range.start), end = domPoint(root, range.end)
  if (!start || !end) return
  const selection = root.ownerDocument.getSelection()
  if (range.backward) selection?.setBaseAndExtent(...end, ...start)
  else selection?.setBaseAndExtent(...start, ...end)
}

/** 由显示行回到真实文件行，只摘取手势起始侧的代码，不含行号或空行占位。 */
export function codeExcerpt(lines: readonly FileDiffLine[], range: CodeRange, diff: boolean): CodeExcerpt | null {
  const anchor = range.backward ? range.end : range.start
  const side = diff && lines[anchor.row]?.newLine === null ? 'L' : 'R'
  const parts: string[] = []
  let line = 0, endLine = 0, startOffset = 0, endOffset = 0
  for (let row = range.start.row; row <= range.end.row; row++) {
    const entry = lines[row]
    if (!entry) return null
    const number = side === 'L' ? entry.oldLine : entry.newLine
    if (number === null) continue
    const from = row === range.start.row ? Math.min(range.start.offset, entry.text.length) : 0
    const to = row === range.end.row ? Math.min(range.end.offset, entry.text.length) : entry.text.length
    if (!line) { line = number; startOffset = from }
    endLine = number
    endOffset = to
    parts.push(entry.text.slice(from, to))
  }
  const text = parts.join('\n')
  return text ? { line, endLine, startOffset, endOffset, text, ...(diff ? { side } : {}) } : null
}

/** 文件刷新后只在原位置与原文仍一致时锚定行内批注。 */
export function excerptRow(lines: readonly FileDiffLine[], excerpt: CodeExcerpt): number | null {
  const field = excerpt.side === 'L' ? 'oldLine' : 'newLine'
  const start = excerpt.side ? lines.findIndex(line => line[field] === excerpt.line) : excerpt.line - 1
  if (start < 0 || lines[start]?.[field] !== excerpt.line) return null
  let offset = 0
  for (let index = start; index < lines.length; index++) {
    const entry = lines[index]!
    const number = entry[field]
    if (number === null) continue
    if (number > excerpt.endLine) break
    const to = number === excerpt.endLine ? excerpt.endOffset : entry.text.length
    if (to > entry.text.length || number === excerpt.line && excerpt.startOffset > entry.text.length) return null
    const part = entry.text.slice(number === excerpt.line ? excerpt.startOffset : 0, to)
    if (!excerpt.text.startsWith(part, offset)) return null
    offset += part.length
    if (number === excerpt.endLine) return offset === excerpt.text.length ? start : null
    if (excerpt.text[offset++] !== '\n') return null
  }
  return null
}
