import { IMAGE_MEDIA_TYPES, type DocumentFormat } from '@whycode/core/document-formats'
export { documentFormat, type DocumentFormat } from '@whycode/core/document-formats'

export const PREVIEW_SCHEME = 'whycode-preview'
export const MAX_PREVIEW_VIEWS = 64
export const DIRECTORY_PAGE_SIZE = 200
export const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024
export const MAX_DOCUMENT_PREVIEW_BYTES = 64 * 1024 * 1024

export interface DirectoryEntry {
  name: string
  path: string
  kind: 'directory' | 'file' | 'other'
}

export interface WorkspaceDirectory {
  kind: 'directory'
  id: string
  path: string
  entries: DirectoryEntry[]
  total: number
  missing: boolean
}

export interface WorkspaceDocument {
  kind: 'file'
  id: string
  path: string
  name: string
  format: DocumentFormat
  mediaType: string
  size: number
  url: string | null
}

export type WorkspaceFileView = WorkspaceDirectory | WorkspaceDocument
export type WorkspaceFileResult = { ok: true; view: WorkspaceFileView } | { ok: false; error: string }

export interface OpenWorkspaceFileRequest {
  runtimeId: string
  kind: 'directory' | 'file'
  /** 目录相对于会话工作路径；文件使用用户实际打开的绝对路径。 */
  path: string
}

export interface ReadWorkspaceFileRequest {
  id: string
  offset?: number
}

export interface WorkspaceFileChange {
  id: string
}

const ASSET_TYPES: Record<string, string> = {
  ...IMAGE_MEDIA_TYPES, html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf',
}

export function previewMediaType(path: string): string | null {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
  return Object.hasOwn(ASSET_TYPES, extension) ? ASSET_TYPES[extension]! : null
}
