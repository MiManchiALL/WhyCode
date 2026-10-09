export interface GitStatusEntry { code: string; path: string; oldPath?: string }

/** -z 不引用路径；重命名的第二条记录是来源，不能当成另一个文件。 */
export function parsePorcelainStatus(output: string): GitStatusEntry[] {
  const records = output.split('\0')
  const entries: GitStatusEntry[] = []
  for (let index = 0; index < records.length - 1; index++) {
    const record = records[index]
    if (!record || record.length < 4) continue
    const code = record.slice(0, 2)
    const path = record.slice(3)
    const oldPath = code.includes('R') || code.includes('C') ? records[++index] : undefined
    entries.push({ code, path, ...(oldPath ? { oldPath } : {}) })
  }
  return entries
}
