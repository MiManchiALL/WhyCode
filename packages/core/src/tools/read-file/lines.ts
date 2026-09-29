import type { Readable } from 'node:stream'

/** readline 会累积完整单行；此处只保留展示所需前缀，丢弃超长行的其余字符。 */
export async function* boundedLines(stream: Readable, maxChars: number): AsyncGenerator<string> {
  let prefix = ''
  let skipLf = false
  for await (const chunk of stream) {
    const text = String(chunk)
    let start = skipLf && text.startsWith('\n') ? 1 : 0
    if (text.length === 0) continue
    skipLf = false
    const breaks = /[\r\n]/gu
    breaks.lastIndex = start
    let match: RegExpExecArray | null
    while ((match = breaks.exec(text)) !== null) {
      prefix += text.slice(start, Math.min(match.index, start + maxChars + 1 - prefix.length))
      yield prefix
      prefix = ''
      start = match.index + 1
      if (match[0] === '\r') {
        if (text[start] === '\n') start++
        else if (start === text.length) skipLf = true
      }
      breaks.lastIndex = start
    }
    prefix += text.slice(start, start + Math.max(0, maxChars + 1 - prefix.length))
  }
  if (prefix) yield prefix
}
