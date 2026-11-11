import type { Readable } from 'node:stream'

/** 同一逻辑行可随 UTF-8 解码流分多段交付，读取方无需等待超长行结束。 */
export async function* lineParts(stream: Readable): AsyncGenerator<{ number: number; text: string }> {
  let number = 1
  let skipLf = false
  for await (const chunk of stream) {
    const text = String(chunk)
    if (text.length === 0) continue
    let start = skipLf && text.startsWith('\n') ? 1 : 0
    skipLf = text.endsWith('\r')
    const breaks = /\r\n?|\n/gu
    breaks.lastIndex = start
    let match: RegExpExecArray | null
    while ((match = breaks.exec(text)) !== null) {
      yield { number, text: text.slice(start, match.index) }
      number++
      start = breaks.lastIndex
    }
    if (start < text.length) yield { number, text: text.slice(start) }
  }
}
