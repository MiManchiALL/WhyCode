import { createMathPlugin } from '@streamdown/math'

const SETTLED_MARKDOWN_PLUGINS = {
  math: createMathPlugin({ singleDollarTextMath: true }),
} as const

const ATTACHED_DISPLAY_MATH = /^( {0,3})(\${2,})(?![ \t]*(?:\r?$))([\s\S]*?)\2[ \t]*(?=\r?$)/gmu

export function markdownPluginsFor(enabled: boolean) {
  return enabled ? SETTLED_MARKDOWN_PLUGINS : undefined
}

export function normalizeDisplayMathFences(markdown: string): string {
  if (!markdown.includes('$$')) return markdown

  let result = ''
  let prose = ''
  let codeFence: { marker: '`' | '~'; length: number } | null = null

  const flushProse = () => {
    result += normalizeAttachedDisplayMath(prose)
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

function normalizeAttachedDisplayMath(markdown: string): string {
  return markdown.replace(
    ATTACHED_DISPLAY_MATH,
    (match, indent: string, fence: string, body: string) => {
      const newline = match.includes('\r\n') ? '\r\n' : '\n'
      return `${indent}${fence}${newline}${indent}${body}${newline}${indent}${fence}`
    },
  )
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
