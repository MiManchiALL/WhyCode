export type SearchRow = string | { path: string; line: string }

const MAX_PAGE_BYTES = 32 * 1024 - 256 // 为续页和未检索说明留出空间。

export class SearchPage {
  readonly offset: number
  readonly limit: number
  remainingSkip: number
  private readonly rows: SearchRow[] = []
  private bytes = 0
  private more = false

  constructor(offset: number, limit: number) {
    this.offset = offset
    this.limit = limit
    this.remainingSkip = offset
  }

  /** 返回 false 时，本条已证实有下一页，不属于本页。 */
  add(row: SearchRow): boolean {
    if (this.remainingSkip > 0) { this.remainingSkip--; return true }
    const previous = this.rows.at(-1)
    let bytes = Buffer.byteLength(typeof row === 'string' ? row : row.line) + (previous === undefined ? 0 : 1)
    if (typeof row !== 'string' && !(typeof previous === 'object' && row.path === previous.path)) {
      bytes += Buffer.byteLength(row.path) + 1
    }
    if (this.rows.length >= this.limit || this.bytes + bytes > MAX_PAGE_BYTES) {
      if (!this.rows.length) throw new Error('单条搜索结果超过 32 KiB，请缩小路径范围')
      this.more = true
      return false
    }
    this.bytes += bytes
    this.rows.push(row)
    return true
  }

  result(empty: string, incomplete?: string, formatPaths?: (paths: string[]) => string[]) {
    let lines: string[] = []
    for (const [i, row] of this.rows.entries()) {
      if (typeof row === 'string') { lines.push(row); continue }
      const previous = this.rows[i - 1]
      const next = this.rows[i + 1]
      if (typeof previous === 'object' && previous.path === row.path) lines.push(row.line)
      else if (typeof next === 'object' && next.path === row.path) lines.push(row.path, row.line)
      else lines.push(`${row.path}:${row.line}`)
    }
    if (formatPaths) lines = formatPaths(lines)
    if (!lines.length && !incomplete) lines.push(this.offset ? '（已到结果末尾）' : empty)
    if (this.more) lines.push(`[用 offset=${this.offset + this.rows.length} 继续]`)
    if (incomplete) lines.push(`[${incomplete}]`)
    return { data: lines.join('\n'), isError: false }
  }
}
