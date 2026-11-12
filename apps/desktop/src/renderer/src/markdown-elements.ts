import { createElement, type ComponentProps, type ReactNode } from 'react'
import { fileName, resolveWorkspaceFilePath, isWindowsAbsolutePath } from './local-files.ts'
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
  onOpenFile: (page: Extract<RightPanelPage, { kind: 'file' }>) => void
}

export function MarkdownFileLink({ path, line, endLine, baseDir, onOpenFile, children }:
  MarkdownFileTarget & FileLinkNavigation & { children?: ReactNode }) {
  // Windows 会把 POSIX 根路径解释到当前盘符，两种工作区的绝对路径不能互换。
  if (isWindowsAbsolutePath(baseDir) ? path.startsWith('/') : isWindowsAbsolutePath(path)) return children
  const fullPath = resolveWorkspaceFilePath(path, baseDir)
  return createElement('button', {
    type: 'button',
    className: 'wc-path-reference wc-file-link wc-focus-ring',
    title: line ? `${fullPath}:${line}${endLine ? `–${endLine}` : ''}` : fullPath,
    onClick: () => onOpenFile({
      kind: 'file', path: fullPath, name: fileName(fullPath), previewMode: line ? 'code' : 'preview',
      source: { kind: 'current', ...(line ? { location: { line, ...(endLine ? { endLine } : {}) } } : {}) },
    }),
  }, children)
}

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ')
}
