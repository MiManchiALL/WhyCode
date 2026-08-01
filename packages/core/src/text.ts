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
