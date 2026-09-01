import { cjk } from '@streamdown/cjk'
import { createMathPlugin } from '@streamdown/math'
import remarkFrontmatter from 'remark-frontmatter'
import { defaultRemarkPlugins } from 'streamdown'

const BASE_MARKDOWN_PLUGINS = { cjk } as const
const MARKDOWN_REMARK_PLUGINS = [
  ...Object.values(defaultRemarkPlugins),
  remarkFrontmatter,
]

const SETTLED_MARKDOWN_PLUGINS = {
  ...BASE_MARKDOWN_PLUGINS,
  math: createMathPlugin({ singleDollarTextMath: true }),
} as const

const ATTACHED_DISPLAY_MATH = /^( {0,3})(\${2,})(?![ \t]*(?:\r?$))([\s\S]*?)\2[ \t]*(?=\r?$)/gmu
const LATEX_MATH_DELIMITERS = [
  { open: String.raw`\(`, close: String.raw`\)`, fence: '$' },
  { open: String.raw`\[`, close: String.raw`\]`, fence: '$$' },
] as const

export function markdownPluginsFor(renderMath: boolean) {
  return renderMath ? SETTLED_MARKDOWN_PLUGINS : BASE_MARKDOWN_PLUGINS
}

export function markdownRemarkPlugins() {
  return MARKDOWN_REMARK_PLUGINS
}

/** remark-math 只识别美元语法；统一模型常用 TeX 定界符时不能误处理代码示例。 */
export function normalizeMathDelimiters(markdown: string): string {
  if (
    !markdown.includes('$$')
    && !markdown.includes(String.raw`\(`)
    && !markdown.includes(String.raw`\[`)
  ) return markdown

  let result = ''
  let prose = ''
  let codeFence: { marker: '`' | '~'; length: number } | null = null

  const flushProse = () => {
    result += normalizeProseMath(prose)
    prose = ''
  }

  for (const line of markdown.split(/(?<=\n)/u)) {
    const content = line.replace(/\r?\n$/u, '')
    const fence = markdownCodeFence(content)

    if (codeFence) {
      result += line
      if (
        fence
        && fence.marker === codeFence.marker
        && fence.length >= codeFence.length
        && fence.closing
      ) {
        codeFence = null
      }
      continue
    }

    if (fence) {
      flushProse()
      result += line
      codeFence = { marker: fence.marker, length: fence.length }
      continue
    }

    prose += line
  }

  flushProse()
  return result
}

function normalizeProseMath(markdown: string): string {
  let result = ''
  let plainStart = 0
  let cursor = 0

  const flushPlain = (end: number) => {
    if (end <= plainStart) return
    result += normalizeMathSyntax(
      markdown.slice(plainStart, end),
      plainStart === 0 || markdown[plainStart - 1] === '\n',
    )
  }

  while (cursor < markdown.length) {
    if (markdown[cursor] !== '`' || isEscaped(markdown, cursor)) {
      cursor++
      continue
    }
    const length = characterRunLength(markdown, cursor, '`')
    const closing = findMatchingBacktickRun(markdown, cursor + length, length)
    if (closing < 0) {
      cursor += length
      continue
    }
    flushPlain(cursor)
    const end = closing + length
    result += markdown.slice(cursor, end)
    cursor = end
    plainStart = end
  }

  flushPlain(markdown.length)
  return result
}

function normalizeMathSyntax(markdown: string, startsAtLineBoundary: boolean): string {
  return normalizeAttachedDisplayMath(
    normalizeLatexMathDelimiters(markdown),
    startsAtLineBoundary,
  )
}

function normalizeLatexMathDelimiters(markdown: string): string {
  let result = ''
  let copiedThrough = 0
  let cursor = 0
  const newline = markdown.includes('\r\n') ? '\r\n' : '\n'
  let active: {
    delimiter: (typeof LATEX_MATH_DELIMITERS)[number]
    openAt: number
    bodyStart: number
  } | null = null

  while (cursor < markdown.length) {
    if (!active) {
      const delimiter = markdown[cursor] === '\\' && !isEscaped(markdown, cursor)
        ? LATEX_MATH_DELIMITERS.find(({ open }) => markdown.startsWith(open, cursor))
        : undefined
      if (!delimiter) {
        cursor++
        continue
      }
      active = {
        delimiter,
        openAt: cursor,
        bodyStart: cursor + delimiter.open.length,
      }
      cursor = active.bodyStart
      continue
    }

    if (
      markdown.startsWith(active.delimiter.close, cursor)
      && !isEscaped(markdown, cursor)
    ) {
      result += markdown.slice(copiedThrough, active.openAt)
      const closeEnd = cursor + active.delimiter.close.length
      result += normalizedLatexMath(
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

function normalizedLatexMath(
  markdown: string,
  active: {
    delimiter: (typeof LATEX_MATH_DELIMITERS)[number]
    openAt: number
    bodyStart: number
  },
  closeAt: number,
  closeEnd: number,
  newline: string,
): string {
  const body = markdown.slice(active.bodyStart, closeAt)
  if (active.delimiter.fence === '$') return `$${body}$`

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

function characterRunLength(markdown: string, start: number, character: string): number {
  let cursor = start
  while (markdown[cursor] === character) cursor++
  return cursor - start
}

function findMatchingBacktickRun(
  markdown: string,
  start: number,
  length: number,
): number {
  let cursor = start
  while (cursor < markdown.length) {
    if (markdown[cursor] !== '`') {
      cursor++
      continue
    }
    const candidateLength = characterRunLength(markdown, cursor, '`')
    if (candidateLength === length) return cursor
    cursor += candidateLength
  }
  return -1
}

function isEscaped(markdown: string, index: number): boolean {
  let backslashes = 0
  for (let cursor = index - 1; cursor >= 0 && markdown[cursor] === '\\'; cursor--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

function markdownCodeFence(line: string): {
  marker: '`' | '~'
  length: number
  closing: boolean
} | null {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line)
  if (!match) return null

  const sequence = match[2]!
  return {
    marker: sequence[0] as '`' | '~',
    length: sequence.length,
    closing: match[3]!.trim().length === 0,
  }
}
