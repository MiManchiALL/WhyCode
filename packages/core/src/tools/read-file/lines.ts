import type { Readable } from 'node:stream'

/** 有界扫描；额外保留一个字符供调用方检测超限，跳过长行时也不会累积整行。 */
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
