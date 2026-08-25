import type { ModelMessage } from 'ai'

export function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('\n')
}

export function normalizeBoundedText(
  value: unknown,
  maxChars: number,
  allowEmpty = false,
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.replace(/\s+/gu, ' ').trim()
  if (!normalized && !allowEmpty) return null
  return normalized.slice(0, maxChars)
}

export function unicodeSafePrefix(value: string, maxCodeUnits: number): string {
  let end = Math.min(value.length, maxCodeUnits)
  if (
    end > 0
    && end < value.length
    && /[\uD800-\uDBFF]/u.test(value[end - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[end]!)
  ) end--
  return value.slice(0, end)
}

export function unicodeSafeSuffix(value: string, maxCodeUnits: number): string {
  let start = Math.max(0, value.length - Math.max(0, maxCodeUnits))
  if (
    start > 0
    && start < value.length
    && /[\uD800-\uDBFF]/u.test(value[start - 1]!)
    && /[\uDC00-\uDFFF]/u.test(value[start]!)
  ) start++
  return value.slice(start)
}

/** Provider JSON 边界要求合法 Unicode scalar sequence，拒绝任何孤立代理项。 */
export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
      index++
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return false
    }
  }
  return true
}
