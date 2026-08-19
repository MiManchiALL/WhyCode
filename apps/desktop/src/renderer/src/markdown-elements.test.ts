import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { Streamdown } from 'streamdown'
import { MarkdownAnchor, MarkdownUnorderedList } from './markdown-elements.ts'

describe('Markdown 自定义元素契约', () => {
  it('普通无序列表保留 Streamdown 的圆点、缩进与语义标记', () => {
    const document = renderedDocument('具体变化：\n\n- 一级\n  - 二级')
    const lists = [...document.querySelectorAll('ul')]

    assert.equal(lists.length, 2)
    for (const list of lists) {
      assert.equal(list.getAttribute('data-streamdown'), 'unordered-list')
      assert.match(list.className, /\bwc-markdown-list\b/u)
      assert.match(list.className, /\blist-disc\b/u)
      assert.match(list.className, /\blist-inside\b/u)
      assert.match(list.className, /\[li_&\]:pl-6/u)
    }
  })

  it('普通链接保留可识别样式与 Streamdown 语义标记', () => {
    const document = renderedDocument('[官方文档](https://example.com/docs)')
    const link = document.querySelector('a')

    assert.ok(link)
    assert.equal(link.getAttribute('data-streamdown'), 'link')
    assert.match(link.className, /\bfont-medium\b/u)
    assert.match(link.className, /\btext-primary\b/u)
    assert.match(link.className, /\bunderline\b/u)
  })
})

function renderedDocument(source: string) {
  const html = renderToStaticMarkup(createElement(
    Streamdown,
    {
      mode: 'static',
      linkSafety: { enabled: false },
      components: {
        ul: MarkdownUnorderedList,
        a: MarkdownAnchor,
      },
    },
    source,
  ))
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document
}
