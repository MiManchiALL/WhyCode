import type { Minimatch } from 'minimatch'
import { localWorkspaceIO } from '../../workspace/io.ts'
import { displayToolPath } from '../fs-utils.ts'
import type { ToolContext } from '../tool.ts'
import { incompleteScan, walkSearchFiles } from './fallback.ts'
import type { SearchPage } from './page.ts'

const STAT_BATCH_SIZE = 32

export async function fallbackGlob(root: string, matcher: Minimatch, gitignore: boolean, page: SearchPage, ctx: ToolContext) {
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const status = { limited: false, unreadable: 0 }
  const matches: { path: string; mtimeMs: number }[] = []
  const batch: string[] = []
  // 一条额外的候选用来确认下一页。分批淘汰旧文件，限制浅分页所需的内存。
  const keep = page.offset + page.limit + 1
  function keepNewest() {
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    if (matches.length > keep) matches.length = keep
  }
  async function readTimes() {
    const stats = await Promise.allSettled(batch.map(path => io.fs.lstat(path)))
    ctx.abortSignal.throwIfAborted()
    for (const [index, result] of stats.entries()) {
      if (result.status === 'rejected') {
        const code = (result.reason as NodeJS.ErrnoException).code
        if (code === 'ENOENT') continue
        if (code === 'EACCES' || code === 'EPERM') { status.unreadable++; continue }
        throw result.reason
      }
      const stat = result.value
      if (!stat.isFile()) continue
      if (stat.mtimeMs === undefined) { status.unreadable++; continue }
      matches.push({ path: batch[index]!, mtimeMs: stat.mtimeMs })
    }
    batch.length = 0
    if (matches.length >= 2 * keep) keepNewest()
  }

  for await (const path of walkSearchFiles(root, gitignore, status, ctx)) {
    if (!matcher.match(io.path.relative(root, path).replaceAll('\\', '/'))) continue
    batch.push(path)
    if (batch.length === STAT_BATCH_SIZE) await readTimes()
  }
  if (batch.length) await readTimes()
  keepNewest()
  for (const file of matches) {
    if (!page.add(displayToolPath(ctx.projectDir, root, file.path, io))) break
  }
  return incompleteScan(status)
}
