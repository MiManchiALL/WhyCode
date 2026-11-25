import { localWorkspaceIO } from '../../workspace/io.ts'
import { readBoundedWorkspaceFile, WorkspaceFileTooLargeError } from '../../workspace/read.ts'
import { displayToolPath } from '../fs-utils.ts'
import { incompleteScan, walkSearchFiles } from './fallback.ts'
import { matchFallbackBatches, type GrepOptions, type SearchFile } from './fallback-worker.ts'
import type { SearchPage } from './page.ts'
import type { Minimatch } from 'minimatch'
import type { ToolContext } from '../tool.ts'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const READ_BATCH_SIZE = 16

export async function fallbackGrep(
  scope: { root: string; onlyFile?: string; include?: Minimatch; gitignore: boolean },
  options: GrepOptions, page: SearchPage, ctx: ToolContext,
) {
  const { root, onlyFile, include, gitignore } = scope
  const { projectDir, abortSignal: signal } = ctx
  const io = ctx.workspaceIO ?? localWorkspaceIO
  const status = { limited: false, unreadable: 0 }
  let large = 0
  let binary = false
  async function read(path: string): Promise<SearchFile | undefined> {
    try {
      const bytes = await readBoundedWorkspaceFile(path, MAX_FILE_BYTES, io, signal)
      if (bytes.subarray(0, 512).includes(0)) { binary = true; return }
      return { path: displayToolPath(projectDir, root, path, io), text: bytes.toString('utf8') }
    } catch (error) {
      if (error instanceof WorkspaceFileTooLargeError) { large++; return }
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') { status.unreadable++; return }
      throw error
    }
  }
  async function* batches() {
    const files = onlyFile ? [onlyFile] : walkSearchFiles(root, gitignore, status, ctx)
    let paths: string[] = []
    const readBatch = async () => {
      const files: SearchFile[] = []
      for (const result of await Promise.allSettled(paths.map(read))) {
        if (result.status === 'rejected') throw result.reason
        if (result.value) files.push(result.value)
      }
      return files
    }
    for await (const path of files) {
      if (include && !include.match(io.path.relative(root, path).replaceAll('\\', '/'))) continue
      paths.push(path)
      if (paths.length === READ_BATCH_SIZE) { yield await readBatch(); paths = [] }
    }
    // 空批次也让 Worker 报告无效正则。
    yield await readBatch()
  }
  await matchFallbackBatches(options, batches(), signal, page)
  if (onlyFile && (large || binary || status.unreadable)) {
    const reason = large ? '文件超过回退搜索的 2 MiB 上限' : binary ? '二进制文件' : '文件不可读取'
    return { data: `未搜索 ${displayToolPath(projectDir, root, onlyFile, io)}：${reason}`, isError: true }
  }
  return page.result('（无匹配）', incompleteScan(status, large))
}
