import type { Nodes } from 'mdast'
import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import remarkFrontmatter from 'remark-frontmatter'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { defaultRehypePlugins, defaultRemarkPlugins } from 'streamdown'
import { rehypeSourceCitations, remarkSourceCitations } from './markdown-sources.ts'
import { remarkMathSyntax } from './markdown-math.ts'

const BASE_MARKDOWN_PLUGINS = { cjk } as const
const STREAMING_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkSourceCitations,
]
const MARKDOWN_REMARK_PLUGINS = [...STREAMING_REMARK_PLUGINS, remarkFrontmatter]
export const MARKDOWN_REHYPE_PLUGINS = [...Object.values(defaultRehypePlugins), rehypeSourceCitations]

const SETTLED_MARKDOWN_PLUGINS = {
  ...BASE_MARKDOWN_PLUGINS,
  math: { ...createMathPlugin(), remarkPlugin: remarkMathSyntax },
} as const

const MARKDOWN_PARSER = unified().use(remarkParse)
  .use(cjk.remarkPluginsBefore).use(MARKDOWN_REMARK_PLUGINS).use(cjk.remarkPluginsAfter)
  .use([SETTLED_MARKDOWN_PLUGINS.math.remarkPlugin])

export function parseMarkdown(text: string) {
  return MARKDOWN_PARSER.parse(text)
}

const ATTACHED_DISPLAY_MATH = /^( {0,3})(\${2,})(?![ \t]*(?:\r?$))([\s\S]*?)\2[ \t]*(?=\r?$)/gmu
const DISPLAY_MATH_OPEN = String.raw`\[`
const DISPLAY_MATH_CLOSE = String.raw`\]`

export function markdownPluginsFor(renderMath: boolean) {
  return renderMath ? SETTLED_MARKDOWN_PLUGINS : BASE_MARKDOWN_PLUGINS
}

export function markdownRemarkPlugins(streaming = false) {
  return streaming ? STREAMING_REMARK_PLUGINS : MARKDOWN_REMARK_PLUGINS
}

/** 只规范化附着正文的块级公式；行内定界符由同一数学语法插件解析。 */
export function normalizeMathDelimiters(markdown: string): string {
  if (
    !markdown.includes('$$')
    && !markdown.includes(String.raw`\[`)
  ) return markdown

  const originalRanges = markdownLiteralRanges(markdown)
  const normalized = normalizeTexDisplayMath(markdown, originalRanges)
  if (!normalized.includes('$$')) return normalized
  const excluded = normalized === markdown ? originalRanges : markdownLiteralRanges(normalized)
  let result = ''
  let offset = 0
  for (const range of excluded) {
    result += normalizeAttachedDisplayMath(normalized.slice(offset, range.start), offset === 0 || normalized[offset - 1] === '\n')
    result += normalized.slice(range.start, range.end)
    offset = range.end
  }
  return result + normalizeAttachedDisplayMath(normalized.slice(offset), offset === 0 || normalized[offset - 1] === '\n')
}

function markdownLiteralRanges(markdown: string): Array<{ start: number; end: number }> {
  const excluded: Array<{ start: number; end: number }> = []
  const collect = (node: Nodes): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    // 双美元仍需判断整行 display 形式，其余已解析的行内公式保持原样。
    const inlineMath = node.type === 'inlineMath' && start !== undefined && !markdown.startsWith('$$', start)
    if (inlineMath || ['code', 'inlineCode', 'link', 'linkReference', 'definition', 'image', 'imageReference', 'html', 'yaml'].includes(node.type)) {
      if (start !== undefined && end !== undefined) excluded.push({ start, end })
    } else if ('children' in node) {
      for (const child of node.children) collect(child)
    }
  }
  collect(parseMarkdown(markdown))
  return excluded
}

function normalizeTexDisplayMath(markdown: string, excluded: readonly { start: number; end: number }[]): string {
  let result = ''
  let copiedThrough = 0
  let cursor = 0
  let rangeIndex = 0
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n'
  let active: {
    openAt: number
    bodyStart: number
  } | null = null

  while (cursor < markdown.length) {
    const range = excluded[rangeIndex]
    if (range && cursor >= range.start) {
      cursor = range.end
      rangeIndex++
      continue
    }
    if (!active) {
      if (!markdown.startsWith(DISPLAY_MATH_OPEN, cursor) || isEscaped(markdown, cursor)) {
        cursor++
        continue
      }
      active = {
        openAt: cursor,
        bodyStart: cursor + DISPLAY_MATH_OPEN.length,
      }
      cursor = active.bodyStart
      continue
    }

    if (
      markdown.startsWith(DISPLAY_MATH_CLOSE, cursor)
      && !isEscaped(markdown, cursor)
    ) {
      result += markdown.slice(copiedThrough, active.openAt)
      const closeEnd = cursor + DISPLAY_MATH_CLOSE.length
      result += normalizedDisplayMath(
        markdown,
        active,
        cursor,
        closeEnd,
        newline,
      )
      cursor = closeEnd
      copiedThrough = cursor
      active = null
    } else {
      cursor++
    }
  }

  result += markdown.slice(copiedThrough)
  return result
}

function normalizedDisplayMath(
  markdown: string,
  active: {
    openAt: number
    bodyStart: number
  },
  closeAt: number,
  closeEnd: number,
  newline: string,
): string {
  const body = markdown.slice(active.bodyStart, closeAt)
  const startsOnOwnLine = linePrefixIsWhitespace(markdown, active.openAt)
  const endsOnOwnLine = lineSuffixIsWhitespace(markdown, closeEnd)
  if (startsOnOwnLine && endsOnOwnLine) return `$$${body}$$`

  const before = startsOnOwnLine ? '' : `${newline}${newline}`
  const after = endsOnOwnLine ? '' : `${newline}${newline}`
  return `${before}$$${newline}${body.trim()}${newline}$$${after}`
}

function linePrefixIsWhitespace(markdown: string, index: number): boolean {
  const lineStart = markdown.lastIndexOf('\n', index - 1) + 1
  return /^[ \t]*$/u.test(markdown.slice(lineStart, index))
}

function lineSuffixIsWhitespace(markdown: string, index: number): boolean {
  const nextLine = markdown.indexOf('\n', index)
  const lineEnd = nextLine < 0 ? markdown.length : nextLine
  return /^[ \t]*\r?$/u.test(markdown.slice(index, lineEnd))
}

function normalizeAttachedDisplayMath(
  markdown: string,
  startsAtLineBoundary: boolean,
): string {
  return markdown.replace(
    ATTACHED_DISPLAY_MATH,
    (match, indent: string, fence: string, body: string, offset: number) => {
      if (offset === 0 && !startsAtLineBoundary) return match
      const newline = match.includes('\r\n') ? '\r\n' : '\n'
      return `${indent}${fence}${newline}${indent}${body}${newline}${indent}${fence}`
    },
  )
}

function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor--) {
    backslashes++
  }
  return backslashes % 2 === 1
}
