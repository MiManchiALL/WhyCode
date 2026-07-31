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
