import { randomUUID } from 'node:crypto'
import { createReadStream, watch, type FSWatcher } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import {
  DIRECTORY_PAGE_SIZE, MAX_DOCUMENT_PREVIEW_BYTES, MAX_PREVIEW_VIEWS,
  MAX_TEXT_PREVIEW_BYTES, PREVIEW_SCHEME, documentFormat, previewMediaType,
  type OpenWorkspaceFileRequest, type WorkspaceFileView,
} from '../shared/workspace-files.ts'

interface FileView {
  id: string
  owner: number
  runtimeId: string
  kind: 'directory' | 'file'
  root: string
  path: string
  abort: AbortController
  watcher?: FSWatcher
  timer?: ReturnType<typeof setTimeout>
  changed: (id: string) => void
}

const byName = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })

/** 仅活动视图持有目录监听与预览地址，关闭即撤销，正文不留在宿主缓存。 */
export class WorkspaceFiles {
  private readonly views = new Map<string, FileView>()

  async open(owner: number, request: OpenWorkspaceFileRequest, workingDirectory: string, changed: FileView['changed']): Promise<WorkspaceFileView> {
    if ([...this.views.values()].filter(view => view.owner === owner).length >= MAX_PREVIEW_VIEWS) {
      throw new Error('展开的目录过多，请先收起部分目录')
    }
    const workspaceRoot = resolve(workingDirectory)
    const path = request.kind === 'directory' ? resolve(workspaceRoot, request.path) : resolve(request.path)
    if (request.kind === 'file' && !isAbsolute(request.path)) throw new Error('文件路径必须为绝对路径')
    const root = request.kind === 'directory' || isWithin(workspaceRoot, path) ? workspaceRoot : dirname(path)
    if (!isWithin(root, path)) throw new Error('目录不在当前工作路径中')
    const view: FileView = { id: randomUUID(), owner, runtimeId: request.runtimeId, kind: request.kind, root, path, abort: new AbortController(), changed }
    this.views.set(view.id, view)
    try {
      const result = await this.read(owner, view.id)
      if (this.views.get(view.id) !== view) throw new Error('文件视图已关闭')
      this.observe(view)
      return result
    } catch (error) {
      this.close(owner, view.id)
      throw error
    }
  }

  async read(owner: number, id: string, offset = 0): Promise<WorkspaceFileView> {
    const view = this.owned(owner, id)
    if (!Number.isInteger(offset) || offset < 0) throw new Error('目录读取位置无效')
    if (view.kind === 'directory') {
      try {
        const path = await containedRealPath(view.root, view.path)
        const entries = await readdir(path, { withFileTypes: true })
        this.observe(view)
        entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || byName.compare(a.name, b.name))
        return {
          kind: 'directory', id, path: view.path, missing: false, total: entries.length,
          entries: entries.slice(offset, offset + DIRECTORY_PAGE_SIZE).map(entry => ({
            name: entry.name,
            path: relative(view.root, resolve(view.path, entry.name)).split(sep).join('/'),
            kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          })),
        }
      } catch (error) {
        if (hasCode(error, 'ENOENT') && view.path === view.root) {
          return { kind: 'directory', id, path: view.path, entries: [], total: 0, missing: true }
        }
        throw error
      }
    }
    const path = await containedRealPath(view.root, view.path)
    const info = await stat(path)
    if (!info.isFile()) throw new Error('所选路径不是普通文件')
    let format = documentFormat(path)
    if (info.size > MAX_DOCUMENT_PREVIEW_BYTES) format = 'unsupported'
    if (['code', 'markdown'].includes(format) && info.size > MAX_TEXT_PREVIEW_BYTES) format = 'unsupported'
    if (format === 'code') {
      const file = await open(path, 'r')
      try {
        const sample = Buffer.alloc(Math.min(info.size, 8192))
        const { bytesRead } = await file.read(sample, 0, sample.length, 0)
        if (sample.subarray(0, bytesRead).includes(0)) format = 'unsupported'
      } finally { await file.close() }
    }
    this.observe(view)
    const relativePath = relative(view.root, view.path).split(sep).map(encodeURIComponent).join('/')
    return {
      kind: 'file', id, path: view.path, name: basename(view.path), format, size: info.size,
      mediaType: previewMediaType(path) ?? 'text/plain',
      url: format === 'unsupported' ? null : `${PREVIEW_SCHEME}://${id}/${relativePath}?v=${randomUUID()}`,
    }
  }

  async response(request: Request): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
    try {
      const url = new URL(request.url)
      const view = this.views.get(url.hostname)
      if (!view || view.kind !== 'file') return new Response(null, { status: 404 })
      const decoded = decodeURIComponent(url.pathname.slice(1))
      if (!decoded || decoded.includes('\0') || decoded.includes('\\') || decoded.includes(':')) return new Response(null, { status: 403 })
      const target = resolve(view.root, decoded)
      const primary = target === view.path
      if (!primary && (decoded.split('/').some(part => part.startsWith('.')) || !previewMediaType(target))) {
        return new Response(null, { status: 403 })
      }
      const path = await containedRealPath(view.root, target)
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_DOCUMENT_PREVIEW_BYTES) return new Response(null, { status: 413 })
      if (this.views.get(view.id) !== view) return new Response(null, { status: 404 })
      const mediaType = previewMediaType(path) ?? 'text/plain'
      const headers = new Headers({
        'Content-Type': mediaType + (/(?:^text\/|json$)/u.test(mediaType) ? '; charset=utf-8' : ''),
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
        'Content-Security-Policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' whycode-preview: https: blob:; style-src 'unsafe-inline' whycode-preview: https:; img-src whycode-preview: https: data: blob:; font-src whycode-preview: https: data:; connect-src whycode-preview: https:; base-uri 'none'; form-action 'none'",
      })
      const range = byteRange(request.headers.get('Range'), info.size)
      if (!range) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
      const { start, end, partial } = range
      headers.set('Content-Length', String(Math.max(0, end - start + 1)))
      if (partial) headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
      if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status: partial ? 206 : 200, headers })
      const stream = createReadStream(path, { start, end, signal: AbortSignal.any([request.signal, view.abort.signal]) })
      return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: partial ? 206 : 200, headers })
    } catch { return new Response(null, { status: 404 }) }
  }

  pathFor(owner: number, id: string): string { return this.owned(owner, id).path }

  close(owner: number, id: string): void {
    const view = this.views.get(id)
    if (!view || view.owner !== owner) return
    this.views.delete(id)
    view.abort.abort()
    view.watcher?.close()
    clearTimeout(view.timer)
  }

  closeOwner(owner: number): void {
    for (const view of this.views.values()) if (view.owner === owner) this.close(owner, view.id)
  }

  closeRuntime(runtimeId: string): void {
    for (const view of this.views.values()) if (view.runtimeId === runtimeId) this.close(view.owner, view.id)
  }

  private owned(owner: number, id: string): FileView {
    const view = this.views.get(id)
    if (!view || view.owner !== owner) throw new Error('文件视图已关闭，请重新打开')
    return view
  }

  private observe(view: FileView): void {
    if (view.watcher || this.views.get(view.id) !== view) return
    const path = view.kind === 'directory' ? view.path : dirname(view.path)
    try {
      view.watcher = watch(path, { persistent: false }, () => {
        clearTimeout(view.timer)
        view.timer = setTimeout(() => {
          if (this.views.get(view.id) === view) view.changed(view.id)
        }, 150)
      })
      view.watcher.on('error', () => { view.watcher?.close(); view.watcher = undefined; view.changed(view.id) })
    } catch { /* 尚未创建的草稿目录由显式刷新或运行事件重新读取。 */ }
  }
}

async function containedRealPath(root: string, path: string): Promise<string> {
  const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)])
  if (!isWithin(realRoot, realPath)) throw new Error('路径超出当前工作目录')
  return realPath
}

function isWithin(root: string, path: string): boolean {
  const tail = relative(root, path)
  return tail === '' || (!tail.startsWith(`..${sep}`) && tail !== '..' && !isAbsolute(tail))
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function byteRange(value: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!value) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]))
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1
  return Number.isSafeInteger(start) && start >= 0 && start <= end && start < size
    ? { start, end, partial: true } : null
}
