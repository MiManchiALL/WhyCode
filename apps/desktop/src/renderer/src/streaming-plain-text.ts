const APPEND_PROBE_LENGTH = 32

/**
 * 返回只需追加的后缀；用固定长度的首尾探针识别回滚/快照替换，避免每次
 * 对不断增长的完整文本执行 O(n) 前缀比较。
 */
export function incrementalTextSuffix(previous: string, next: string): string | null {
  if (next.length < previous.length) return null
  if (next.length === previous.length) return next === previous ? '' : null
  const headEnd = Math.min(APPEND_PROBE_LENGTH, previous.length)
  if (next.slice(0, headEnd) !== previous.slice(0, headEnd)) return null
  const tailStart = Math.max(headEnd, previous.length - APPEND_PROBE_LENGTH)
  if (next.slice(tailStart, previous.length) !== previous.slice(tailStart)) return null
  return next.slice(previous.length)
}
