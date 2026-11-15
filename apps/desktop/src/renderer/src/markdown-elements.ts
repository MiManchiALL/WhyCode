import { createElement, type ComponentProps, type ReactNode } from 'react'
import { displayFilePath, fileName, filePathKey, resolveWorkspaceFilePath, isWindowsAbsolutePath } from './local-files.ts'
import type { RightPanelPage } from './right-panel-state.ts'
import type { MarkdownFileTarget } from './markdown-file-links.ts'

type MarkdownElementProps<Tag extends 'a' | 'ul'> = ComponentProps<Tag> & {
  node?: unknown
}

export function MarkdownUnorderedList({
  node: _node,
  className,
  children,
  ...props
}: MarkdownElementProps<'ul'>) {
  return createElement('ul', {
    ...props,
    className: classes(
      'wc-markdown-list',
      'list-inside list-disc whitespace-normal [li_&]:pl-6',
      className,
    ),
    'data-streamdown': 'unordered-list',
  }, children)
}

export function MarkdownAnchor({
  node: _node,
  className,
  children,
  href,
  inlineSource = false,
  webLink = false,
  ...props
}: MarkdownElementProps<'a'> & { inlineSource?: boolean; webLink?: boolean }) {
  return createElement('a', {
    ...props,
    href,
    className: classes(
      'wrap-anywhere font-medium text-primary',
      className,
      inlineSource ? 'wc-inline-source' : webLink ? 'wc-web-link wc-focus-ring' : 'underline',
    ),
    'data-streamdown': 'link',
  }, children)
}

export interface FileLinkNavigation {
  baseDir: string
  workspaceDir?: string | null
  onNavigate: (page: Extract<RightPanelPage, { kind: 'file' | 'workspace' }>) => void
}

export function MarkdownFileLink({ path, line, endLine, baseDir, workspaceDir = baseDir, onNavigate, children }:
  MarkdownFileTarget & FileLinkNavigation & { children?: ReactNode }) {
  // Windows 会把 POSIX 根路径解释到当前盘符，两种工作区的绝对路径不能互换。
  const windows = isWindowsAbsolutePath(baseDir)
  if (windows ? path.startsWith('/') : isWindowsAbsolutePath(path)) return children
  const fullPath = resolveWorkspaceFilePath(path, baseDir)
  const isDirectory = path.endsWith('/') || (windows && path.endsWith('\\'))
  const directory = isDirectory && workspaceDir ? relativeDirectory(fullPath, workspaceDir) : null
  if (isDirectory && directory === null) return children
  return createElement('button', {
    type: 'button',
    className: 'wc-path-reference wc-file-link wc-focus-ring',
    'data-kind': isDirectory ? 'directory' : 'file',
    title: !isDirectory && line ? `${fullPath}:${line}${endLine ? `–${endLine}` : ''}` : fullPath,
    onClick: () => onNavigate(directory !== null ? {
      kind: 'workspace', ...(directory && { directory }), expanded: [],
    } : {
      kind: 'file', path: fullPath, name: fileName(fullPath), previewMode: line ? 'code' : 'preview',
      source: { kind: 'current', ...(line ? { location: { line, ...(endLine ? { endLine } : {}) } } : {}) },
    }),
  }, children)
}

function relativeDirectory(path: string, workspace: string): string | null {
  const root = resolveWorkspaceFilePath('.', workspace)
  if (filePathKey(path) === filePathKey(root)) return ''
  const relative = displayFilePath(path, root)
  if (relative === path) return null
  return isWindowsAbsolutePath(root) ? relative.replaceAll('\\', '/') : relative
}

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ')
}
