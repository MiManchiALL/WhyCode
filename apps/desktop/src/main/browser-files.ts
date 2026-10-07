import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { localWorkspaceIO, type WorkspaceIO } from '@whycode/core'
import { BROWSER_FILE_SCHEME, browserDisplayUrl, isBrowserUrl } from '../shared/browser.ts'
import { pathKey } from './workspace-path.ts'
import { MAX_DOCUMENT_PREVIEW_BYTES, previewMediaType } from '../shared/workspace-files.ts'
import { byteRange } from './workspace-files.ts'

interface DirectoryGrant { root: string; io: WorkspaceIO; owners: Set<string>; abort: AbortController }
const MAX_DIRECTORIES_PER_TAB = 32

/** 本机地址只由宿主输入授予；网页相对资源不能越过已打开目录。 */
export class BrowserFiles {
  private readonly directories = new Map<string, DirectoryGrant>()

  open(owner: string, value: string, io: WorkspaceIO = localWorkspaceIO): string {
    if (!isBrowserUrl(value) || new URL(value).protocol !== 'file:') throw new Error('本机文件地址无效')
    const path = filePath(io, value)
    const root = io.identity === 'local' ? pathKey(io.path.dirname(path)) : io.path.dirname(path)
    // 目录的 origin 稳定，刷新和重新打开文件沿用该目录的网页存储。
    const id = createHash('sha256').update(`${io.identity}:${root}`).digest('hex')
    let grant = this.directories.get(id)
    if (!grant?.owners.has(owner)
      && [...this.directories.values()].filter(item => item.owners.has(owner)).length >= MAX_DIRECTORIES_PER_TAB) {
      throw new Error('此标签打开的本机目录过多，请新建浏览器标签')
    }
    if (!grant) { grant = { root, io, owners: new Set(), abort: new AbortController() }; this.directories.set(id, grant) }
    grant.owners.add(owner)
    const url = new URL(value)
    return `${BROWSER_FILE_SCHEME}://${id}${url.pathname}${url.search}${url.hash}`
  }

  allows(owner: string, value: string): boolean {
    try {
      const url = new URL(value)
      const grant = this.directories.get(url.hostname)
      return url.protocol === `${BROWSER_FILE_SCHEME}:` && !url.username && !url.password && !url.port
        && !!grant?.owners.has(owner) && within(grant.io, grant.root, filePath(grant.io, browserDisplayUrl(value)))
    } catch { return false }
  }

  async resolve(value: string): Promise<string> {
    const url = new URL(value)
    const grant = this.directories.get(url.hostname)
    if (!grant || ![...grant.owners].some(owner => this.allows(owner, value))) throw new Error('本机目录未打开')
    const [root, path] = await Promise.all([grant.io.fs.realpath(grant.root), grant.io.fs.realpath(filePath(grant.io, browserDisplayUrl(value)))])
    if (!within(grant.io, root, path) || !(await grant.io.fs.stat(path)).isFile()
      || this.directories.get(url.hostname) !== grant) throw new Error('文件不在已打开目录中')
    return path
  }

  source(owner: string, value: string): { path: string; remote: boolean } | undefined {
    if (!this.allows(owner, value)) return undefined
    const grant = this.directories.get(new URL(value).hostname)!
    return { path: filePath(grant.io, browserDisplayUrl(value)), remote: grant.io.identity !== 'local' }
  }

  async remoteResponse(request: Request): Promise<Response | null> {
    const grant = this.directories.get(new URL(request.url).hostname)
    if (!grant || grant.io.identity === 'local') return null
    const path = await this.resolve(request.url)
    const size = (await grant.io.fs.stat(path)).size
    if (size > MAX_DOCUMENT_PREVIEW_BYTES) return new Response(null, { status: 413 })
    const range = byteRange(request.headers.get('Range'), size)
    if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    const { start, end, partial } = range
    const mediaType = previewMediaType(path) ?? 'application/octet-stream'
    const headers = new Headers({ 'Content-Type': mediaType + (/(?:^text\/|json$)/u.test(mediaType) ? '; charset=utf-8' : ''),
      'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': String(Math.max(0, end - start + 1)),
      'X-Content-Type-Options': 'nosniff' })
    if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${size}`)
    const body = request.method === 'HEAD' || !size ? null : Readable.toWeb(grant.io.fs.createReadStream(path, {
      start, end, signal: AbortSignal.any([request.signal, grant.abort.signal]),
    })) as ReadableStream<Uint8Array>
    return new Response(body, { status: partial ? 206 : 200, headers })
  }

  release(owner: string): void {
    for (const [id, grant] of this.directories) {
      grant.owners.delete(owner)
      if (!grant.owners.size) { this.directories.delete(id); grant.abort.abort() }
    }
  }
}

function filePath(io: WorkspaceIO, value: string): string {
  if (io.identity === 'local') return fileURLToPath(value)
  const path = decodeURIComponent(new URL(value).pathname)
  if (!io.path.isAbsolute(path) || /[\\\0:]/u.test(path)) throw new Error('远端文件路径无效')
  return path
}

function within(io: WorkspaceIO, root: string, path: string): boolean {
  const tail = io.path.relative(root, path)
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${io.path.sep}`) && !io.path.isAbsolute(tail))
}
