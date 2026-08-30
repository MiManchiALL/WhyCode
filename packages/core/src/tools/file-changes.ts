/** 单个文件在一次工具调用中的 Git 风格行变更统计。 */
export interface ToolFileChange {
  path: string
  added: number
  removed: number
}

interface LineChanges {
  added: number
  removed: number
}

/**
 * 保留换行符拆分逻辑行，确保“补上/删除文件末尾换行”也会计为一行替换。
 * 空文本没有行；单独一个换行符则是一行空白内容。
 */
function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const lines: string[] = []
  let start = 0
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) !== 10) continue
    lines.push(content.slice(start, index + 1))
    start = index + 1
  }
  if (start < content.length) lines.push(content.slice(start))
  return lines
}

/** Myers 最短编辑距离；相等行沿对角线前进，其余步骤只允许插入或删除。 */
function shortestEditDistance(before: readonly string[], after: readonly string[]): number {
  const beforeLength = before.length
  const afterLength = after.length
  const maximum = beforeLength + afterLength
  const offset = maximum + 1
  const frontier = new Int32Array(maximum * 2 + 3)
  frontier.fill(-1)
  frontier[offset + 1] = 0

  for (let distance = 0; distance <= maximum; distance++) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal
      let beforeIndex: number
      if (
        diagonal === -distance
        || (diagonal !== distance && frontier[index - 1]! < frontier[index + 1]!)
      ) {
        beforeIndex = frontier[index + 1]!
      } else {
        beforeIndex = frontier[index - 1]! + 1
      }

      let afterIndex = beforeIndex - diagonal
      while (
        beforeIndex < beforeLength
        && afterIndex < afterLength
        && before[beforeIndex] === after[afterIndex]
      ) {
        beforeIndex++
        afterIndex++
      }
      frontier[index] = beforeIndex
      if (beforeIndex >= beforeLength && afterIndex >= afterLength) return distance
    }
  }

  return maximum
}

/** 精确计算文本从 before 变为 after 所需的最少增删行数。 */
export function countLineChanges(before: string, after: string): LineChanges {
  if (before === after) return { added: 0, removed: 0 }

  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  let start = 0
  while (
    start < beforeLines.length
    && start < afterLines.length
    && beforeLines[start] === afterLines[start]
  ) start++

  let beforeEnd = beforeLines.length
  let afterEnd = afterLines.length
  while (
    beforeEnd > start
    && afterEnd > start
    && beforeLines[beforeEnd - 1] === afterLines[afterEnd - 1]
  ) {
    beforeEnd--
    afterEnd--
  }

  const remainingBefore = beforeLines.slice(start, beforeEnd)
  const remainingAfter = afterLines.slice(start, afterEnd)
  if (remainingBefore.length === 0) {
    return { added: remainingAfter.length, removed: 0 }
  }
  if (remainingAfter.length === 0) {
    return { added: 0, removed: remainingBefore.length }
  }

  // 整文件重写通常没有公共行，避免让 Myers 进入最坏的二次复杂度。
  const smaller = remainingBefore.length <= remainingAfter.length
    ? remainingBefore
    : remainingAfter
  const larger = smaller === remainingBefore ? remainingAfter : remainingBefore
  const smallerLines = new Set(smaller)
  let shared = false
  for (const line of larger) {
    if (!smallerLines.has(line)) continue
    shared = true
    break
  }
  if (!shared) {
    return { added: remainingAfter.length, removed: remainingBefore.length }
  }

  const distance = shortestEditDistance(remainingBefore, remainingAfter)
  const delta = remainingAfter.length - remainingBefore.length
  return {
    added: (distance + delta) / 2,
    removed: (distance - delta) / 2,
  }
}

export function describeFileChange(
  path: string,
  before: string,
  after: string,
): ToolFileChange {
  return { path, ...countLineChanges(before, after) }
}
