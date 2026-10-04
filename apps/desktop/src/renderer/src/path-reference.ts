import type { Nodes } from 'mdast'
import { toString } from 'mdast-util-to-string'
import { parseMarkdown } from './markdown-rendering.ts'

export interface PathReference {
  path: string
  name: string
  kind: 'file' | 'directory'
}

export interface PathReferencePart {
  text: string
  reference?: PathReference
}

export const WORKSPACE_PATH_MIME = 'application/x-whycode-workspace-path'

export function workspacePathReference(root: string, path: string, name: string, kind: PathReference['kind']): PathReference {
  const base = /^[a-z]:[\\/]/iu.test(root) || root.startsWith('\\\\') ? root.replaceAll('\\', '/') : root
  return { path: `${base.replace(/\/$/u, '')}/${path}`, name, kind }
}

export function pathReferenceText(reference: PathReference): string {
  const name = reference.name.replace(/[\\`*_[\]<>!&]/gu, '\\$&').replace(/\r/gu, '&#13;').replace(/\n/gu, '&#10;')
  const path = reference.path + (reference.kind === 'directory' && !reference.path.endsWith('/') ? '/' : '')
  const target = path.replace(/[\\<>&]/gu, '\\$&').replace(/\r/gu, '&#13;').replace(/\n/gu, '&#10;')
  return `[${name}](<${target}>)`
}

/** 引用和发送共用原始文本；语法树排除代码、图片、HTML 和普通网址。 */
export function splitPathReferences(text: string): PathReferencePart[] {
  if (!text.includes('](<')) return [{ text }]
  const parts: PathReferencePart[] = []
  let offset = 0
  const visit = (node: Nodes): void => {
    if (node.type === 'link') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined || node.title || !absolutePath(node.url)) return
      const source = text.slice(start, end)
      if (!source.includes('](<')) return
      if (start > offset) parts.push({ text: text.slice(offset, start) })
      const kind = node.url.endsWith('/') ? 'directory' : 'file'
      parts.push({ text: source, reference: { name: toString(node), path: node.url, kind } })
      offset = end
    } else if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(parseMarkdown(text))
  if (offset < text.length) parts.push({ text: text.slice(offset) })
  return parts.length ? parts : [{ text }]
}

export function readWorkspacePathDrag(data: Pick<DataTransfer, 'getData'>, runtimeId: string): PathReference | null {
  try {
    const payload: unknown = JSON.parse(data.getData(WORKSPACE_PATH_MIME))
    if (!payload || typeof payload !== 'object' || !('runtimeId' in payload) || payload.runtimeId !== runtimeId
      || !('path' in payload) || typeof payload.path !== 'string' || !absolutePath(payload.path)
      || !('name' in payload) || typeof payload.name !== 'string' || !payload.name
      || !('kind' in payload) || (payload.kind !== 'file' && payload.kind !== 'directory')) return null
    return { path: payload.path, name: payload.name, kind: payload.kind }
  } catch { return null }
}

function absolutePath(path: string): boolean {
  return !path.includes('\0') && (path.startsWith('/') || /^[a-z]:[\\/]/iu.test(path))
}
