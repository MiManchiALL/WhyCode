/** 极简 unified diff（无第三方依赖）：整文件旧/新对比，供审批 UI 展示。 */
export function makeDiff(path: string, oldText: string, newText: string): string {
  if (oldText === newText) return ''
  const oldLines = oldText.split('\n')
  const newLines = newText.split('\n')
  const out: string[] = [`--- ${path}`, `+++ ${path}`]
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++
  }
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--
    endNew--
  }
  out.push(`@@ -${start + 1},${endOld - start} +${start + 1},${endNew - start} @@`)
  for (let i = start; i < endOld; i++) out.push(`-${oldLines[i]}`)
  for (let i = start; i < endNew; i++) out.push(`+${newLines[i]}`)
  return out.join('\n')
}
