import { matchFallback } from './fallback-worker.ts'
import type { WorkspaceIO } from '../../workspace/io.ts'
import { readBoundedWorkspaceFile } from '../../workspace/read.ts'
import { displayToolPath } from '../fs-utils.ts'
import { collectFiles, globToRegExp } from './fallback.ts'

export type GrepOutputMode = 'content' | 'files_with_matches' | 'count'
interface Options {
  io: WorkspaceIO
  root: string
  onlyFile?: string
  projectDir: string
  pattern: string
  include?: string
  mode: GrepOutputMode
  caseSensitive: boolean
  literal: boolean
  context: number
  signal: AbortSignal
  resultLimit: number
}
const MAX_FILE_BYTES = 2 * 1024 * 1024
const READ_BATCH_SIZE = 16

export async function fallbackGrep(options: Options): Promise<{ lines: string[]; truncated: boolean }> {
  const { stat } = options.io.fs
  const { relative } = options.io.path
  const collected = options.onlyFile
    ? { files: [options.onlyFile], truncated: false }
    : await collectFiles(options.root, options.signal, options.io)
  const candidates = options.include
    ? (await matchFallback({
        kind: 'glob', files: collected.files.map(path => relative(options.root, path).replaceAll('\\', '/')),
        expression: globToRegExp(options.include).source, limit: collected.files.length,
      }, options.signal)).map(path => options.io.path.join(options.root, path))
    : collected.files.sort()
  const results: string[] = []
  for (let start = 0; start < Math.max(candidates.length, 1); start += READ_BATCH_SIZE) {
    options.signal.throwIfAborted()
    const contents = await Promise.all(candidates.slice(start, start + READ_BATCH_SIZE).map(async path => {
      try {
        const metadata = await stat(path)
        options.signal.throwIfAborted()
        if (metadata.size > MAX_FILE_BYTES) return []
        const bytes = await readBoundedWorkspaceFile(path, MAX_FILE_BYTES, options.io, options.signal)
        if (bytes.subarray(0, 512).includes(0)) return []
        return [{ path: displayToolPath(options.projectDir, options.root, relative(options.root, path), options.io), text: bytes.toString('utf8') }]
      } catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return []
        throw error
      }
    }))
    results.push(...await matchFallback({
      kind: 'grep', files: contents.flat(), limit: options.resultLimit - results.length,
      pattern: options.pattern, literal: options.literal, caseSensitive: options.caseSensitive, mode: options.mode, context: options.context,
    }, options.signal))
    if (results.length >= options.resultLimit) break
  }
  return { lines: results, truncated: collected.truncated || results.length >= options.resultLimit }
}
