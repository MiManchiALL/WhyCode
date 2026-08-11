import { XMLValidator } from 'fast-xml-parser'
import { unicodeSafePrefix } from '@whycode/core'
import { OfficeProcessingError } from '@whycode/core/office'

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  quot: '"',
}

export interface DirectXmlChild {
  name: string
  source: string
}

export function requireValidXml(xml: string, name: string): void {
  const result = XMLValidator.validate(xml)
  if (result !== true) {
    const detail = typeof result === 'object' && result.err?.msg ? `：${result.err.msg}` : ''
    throw new OfficeProcessingError('corrupted', `OOXML 部件格式无效（${name}）${detail}`)
  }
}

export function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    if (entity[0] !== '#') return NAMED_ENTITIES[entity.toLowerCase()] ?? full
    const hexadecimal = entity[1]?.toLowerCase() === 'x'
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
    if (
      !Number.isInteger(codePoint)
      || codePoint < 0
      || codePoint > 0x10ffff
      || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) return '\uFFFD'
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return '\uFFFD'
    }
  })
}

export function elementTexts(xml: string, qualifiedName: string): string[] {
  const escaped = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const expression = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'gi')
  return [...xml.matchAll(expression)].map((match) =>
    normalizeText(decodeXmlText(stripTags(match[1] ?? ''))))
}

export function attributeValue(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\s)${escaped}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(attributes)
  return match ? decodeXmlText(match[1] ?? match[2] ?? '') : null
}

export function normalizeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function boundedText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${unicodeSafePrefix(value, Math.max(0, maxChars - 1))}…`
}

/**
 * 枚举已通过 XMLValidator 校验的 XML 中，指定元素的直接子元素。
 * 默认不复制子元素正文，避免 worksheet 的 sheetData 造成第二份大字符串。
 */
export function directXmlChildren(
  xml: string,
  parentLocalName: string,
  captureSource = false,
): DirectXmlChild[] {
  const children: DirectXmlChild[] = []
  let depth = 0
  let parentDepth: number | null = null
  let current: { name: string; start: number } | null = null
  let cursor = 0

  while (cursor < xml.length) {
    const start = xml.indexOf('<', cursor)
    if (start < 0) break
    const skipped = skipSpecialMarkup(xml, start)
    if (skipped !== null) {
      cursor = skipped
      continue
    }
    const end = findTagEnd(xml, start + 1)
    if (end < 0) break
    const closing = xml[start + 1] === '/'
    const nameStart = start + (closing ? 2 : 1)
    const nameEnd = findNameEnd(xml, nameStart, end)
    const qualifiedName = xml.slice(nameStart, nameEnd)
    const name = localName(qualifiedName)

    if (closing) {
      if (current && parentDepth !== null && depth === parentDepth + 2 && name === current.name) {
        children.push({
          name,
          source: captureSource ? xml.slice(current.start, end + 1) : '',
        })
        current = null
      }
      depth--
      if (parentDepth !== null && depth === parentDepth && name === parentLocalName) break
    } else {
      const selfClosing = isSelfClosing(xml, nameEnd, end)
      if (parentDepth === null && name === parentLocalName) {
        parentDepth = depth
      } else if (parentDepth !== null && depth === parentDepth + 1) {
        if (selfClosing) {
          children.push({ name, source: captureSource ? xml.slice(start, end + 1) : '' })
        } else {
          current = { name, start }
        }
      }
      if (!selfClosing) depth++
    }
    cursor = end + 1
  }
  return children
}

function skipSpecialMarkup(xml: string, start: number): number | null {
  for (const [prefix, suffix] of [
    ['<!--', '-->'],
    ['<![CDATA[', ']]>'],
    ['<?', '?>'],
  ] as const) {
    if (!xml.startsWith(prefix, start)) continue
    const end = xml.indexOf(suffix, start + prefix.length)
    return end < 0 ? xml.length : end + suffix.length
  }
  if (xml.startsWith('<!', start)) {
    const end = findTagEnd(xml, start + 2)
    return end < 0 ? xml.length : end + 1
  }
  return null
}

function findTagEnd(xml: string, start: number): number {
  let quote = ''
  for (let index = start; index < xml.length; index++) {
    const character = xml[index]!
    if (quote) {
      if (character === quote) quote = ''
    } else if (character === '"' || character === "'") {
      quote = character
    } else if (character === '>') {
      return index
    }
  }
  return -1
}

function findNameEnd(xml: string, start: number, tagEnd: number): number {
  let end = start
  while (end < tagEnd && !/[\s/>]/.test(xml[end]!)) end++
  return end
}

function isSelfClosing(xml: string, nameEnd: number, tagEnd: number): boolean {
  let cursor = tagEnd - 1
  while (cursor >= nameEnd && /\s/.test(xml[cursor]!)) cursor--
  return xml[cursor] === '/'
}

function localName(qualifiedName: string): string {
  return qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1)
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}
