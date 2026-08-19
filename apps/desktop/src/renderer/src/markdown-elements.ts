import { createElement, type ComponentProps } from 'react'

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
  ...props
}: MarkdownElementProps<'a'> & { inlineSource?: boolean }) {
  return createElement('a', {
    ...props,
    href,
    className: classes(
      'wrap-anywhere font-medium text-primary underline',
      className,
      inlineSource && 'wc-inline-source',
    ),
    'data-incomplete': href === 'streamdown:incomplete-link',
    'data-streamdown': 'link',
  }, children)
}

function classes(...values: Array<string | false | undefined>): string {
  return values.filter(Boolean).join(' ')
}
