import { unicodeSafePrefix, WEB_PAGE_MAX_LINE_CHARS } from '@whycode/core'

export const WEB_PAGE_MAX_CONTENT_CHARS = 250_000

export interface ExtractedWebPage {
  requestedUrl: string
  finalUrl: string
  title?: string
  contentType: string
  lines: readonly string[]
  sourceTruncated: boolean
}

export interface WebPageContentSource {
  requestedUrl: string
  finalUrl: string
  contentType: string
}

export function createExtractedWebPage(
  source: WebPageContentSource,
  markdown: string,
  options: { title?: string; sourceTruncated?: boolean } = {},
): ExtractedWebPage {
  const bounded = toBoundedLines(markdown)
  return {
    requestedUrl: source.requestedUrl,
    finalUrl: source.finalUrl,
    ...(options.title ? { title: options.title } : {}),
    contentType: source.contentType,
    lines: bounded.lines,
    sourceTruncated: Boolean(options.sourceTruncated) || bounded.truncated,
  }
}

function toBoundedLines(markdown: string): { lines: string[]; truncated: boolean } {
  const normalized = markdown
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .trim()
  if (!normalized) return { lines: [], truncated: false }

  const lines: string[] = []
  let totalChars = 0
  let blankLines = 0
  let truncated = false
  outer: for (const rawLine of normalized.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line) {
      if (blankLines >= 1) continue
      blankLines++
    } else {
      blankLines = 0
    }
    for (const part of splitLongLine(line)) {
      const separatorChars = lines.length > 0 ? 1 : 0
      const addedChars = part.length + separatorChars
      if (totalChars + addedChars > WEB_PAGE_MAX_CONTENT_CHARS) {
        const available = WEB_PAGE_MAX_CONTENT_CHARS - totalChars - separatorChars
        if (available > 0) lines.push(unicodeSafePrefix(part, available))
        truncated = true
        break outer
      }
      lines.push(part)
      totalChars += addedChars
    }
  }
  while (lines.at(-1) === '') lines.pop()
  return { lines, truncated }
}

function splitLongLine(line: string): string[] {
  if (line.length <= WEB_PAGE_MAX_LINE_CHARS) return [line]
  const parts: string[] = []
  let offset = 0
  while (offset < line.length) {
    const part = unicodeSafePrefix(line.slice(offset), WEB_PAGE_MAX_LINE_CHARS)
    parts.push(part)
    offset += part.length
  }
  return parts
}
