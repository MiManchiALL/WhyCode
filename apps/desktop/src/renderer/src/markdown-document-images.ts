import type { Element, Root } from 'hast'
import { createElement, useState, type ComponentProps } from 'react'
import type { ExtraProps } from 'streamdown'
import type { Plugin } from 'unified'

const DOCUMENT_IMAGE_TAG = 'wc-document-image'

/** 把已经净化的图片绑定到当前文件视图，浏览器仍负责选择 picture / srcset 的候选图。 */
export const rehypeDocumentImages: Plugin<[string], Root> = documentUrl => {
  const base = new URL(documentUrl)
  return tree => {
    function visit(parent: Root | Element) {
      for (const node of parent.children) {
        if (node.type !== 'element') continue
        if (node.tagName === 'img' || node.tagName === 'source') {
          const props = node.properties
          const candidates = typeof props.srcSet === 'string' ? imageCandidates(props.srcSet, base) : []
          if (candidates.length) props.srcSet = candidates.join(', ')
          else delete props.srcSet
          if (node.tagName === 'img') {
            const original = typeof props.src === 'string' ? props.src : ''
            const src = documentImageUrl(original, base)
            // 专用组件接管已净化的图片。仅靠 picture 或 srcset 选图时，原生 img 可以没有 src。
            node.tagName = DOCUMENT_IMAGE_TAG
            if (src) props.src = src
            else delete props.src
            props.alt ??= original || '图片'
          }
        } else {
          visit(node)
        }
      }
    }
    visit(tree)
  }
}

function documentImageUrl(value: string, base: URL): string | undefined {
  if (!value || value.startsWith('#') || value.startsWith('?')) return
  const target = URL.parse(value.startsWith('//') ? 'https:' + value : value, base)
  if (!target || target.username || target.password) return
  const revision = base.searchParams.get('v')
  if (target.protocol === 'https:' || target.protocol === 'http:') {
    const preview = new URL('/', base)
    preview.hash = target.hash
    target.hash = ''
    preview.searchParams.set('image', target.href)
    if (revision) preview.searchParams.set('v', revision)
    return preview.href
  }
  if (target.protocol !== base.protocol || target.host !== base.host || target.pathname === '/') return
  target.pathname = target.pathname.replace(/%(?![\da-f]{2})/giu, '%25')
  if (revision) target.searchParams.set('v', revision)
  return target.href
}

function imageCandidates(srcSet: string, base: URL): string[] {
  const candidates: string[] = []
  // srcset 的 URL 只在空白处结束，可以包含逗号。末尾逗号表示此项没有描述符。
  const urls = /[^,\t\n\f\r ][^\t\n\f\r ]*/gu
  for (let token = urls.exec(srcSet); token; token = urls.exec(srcSet)) {
    let descriptor = ''
    if (!token[0].endsWith(',')) {
      const comma = srcSet.indexOf(',', urls.lastIndex)
      const end = comma < 0 ? srcSet.length : comma
      descriptor = srcSet.slice(urls.lastIndex, end).trim()
      urls.lastIndex = end
    }
    const src = documentImageUrl(token[0].replace(/,+$/u, ''), base)
    if (src) candidates.push(descriptor ? src + ' ' + descriptor : src)
  }
  return candidates
}

export function documentImageLink(node: Element | undefined): boolean {
  const children = node?.children.filter(child => child.type !== 'text' || child.value.trim())
  return !!children?.length && children.every(child =>
    child.type === 'element' && (child.tagName === DOCUMENT_IMAGE_TAG || child.tagName === 'picture'))
}

function MarkdownDocumentImage({ node: _node, alt, ...props }: ComponentProps<'img'> & ExtraProps) {
  const [failure, setFailure] = useState('')
  return createElement('img', {
    ...props, alt: failure || alt || '', loading: 'lazy', decoding: 'async',
    className: 'wc-document-image', 'data-failed': failure ? true : undefined,
    onLoad: () => setFailure(''),
    onError: event => {
      const image = event.currentTarget
      const url = URL.parse(image.currentSrc || image.src)
      if (!url) { setFailure(alt || '图片不可用'); return }
      const remote = url.pathname === '/' ? url.searchParams.get('image') : null
      let path = url.pathname.slice(1)
      try { path = decodeURIComponent(path) } catch { /* 保留含有字面百分号的文件名。 */ }
      setFailure(remote ? alt || remote : '图片不可用 · ' + path)
    },
  })
}

export const documentImageComponents = { [DOCUMENT_IMAGE_TAG]: MarkdownDocumentImage }
