/** 仅折叠本页连续出现的目录，保持文件顺序，每页均可独立还原路径。 */
export function formatGlobPaths(paths: string[]): string[] {
  if (paths.length < 3) return paths
  const lines: string[] = []
  function group(start: number, end: number, base: number, depth: number, heading: string) {
    let insideChild = false
    for (let i = start; i < end;) {
      const path = paths[i]!
      const slash = path.indexOf('/', base)
      const prefix = slash < 0 ? '' : path.slice(0, slash + 1)
      let next = i + 1
      let shared = path.lastIndexOf('/') + 1
      while (prefix && next < end && paths[next]!.startsWith(prefix)) {
        const neighbor = paths[next++]!
        let same = prefix.length
        while (same < shared && path[same] === neighbor[same]) same++
        shared = path.lastIndexOf('/', same - 1) + 1
      }
      if (next - i > 1) {
        const title = '#'.repeat(depth + 1) + ' ' + path.slice(base, shared)
        lines.push(title)
        group(i, next, shared, depth + 1, title)
        insideChild = true
      } else {
        if (insideChild) lines.push(heading)
        lines.push(path.slice(base))
        insideChild = false
      }
      i = next
    }
  }
  group(0, paths.length, 0, 0, '# ./')
  const bytes = (rows: string[]) => rows.reduce((total, row) => total + Buffer.byteLength(row) + 1, 0)
  // 仅省几个字符时，完整路径更容易直接使用。
  return bytes(lines) <= bytes(paths) * 0.9 ? lines : paths
}
