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

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '')
}
