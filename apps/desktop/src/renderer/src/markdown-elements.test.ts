import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseHTML } from 'linkedom'
import { Streamdown } from 'streamdown'
import { MarkdownAnchor, MarkdownFileLink, MarkdownUnorderedList } from './markdown-elements.ts'
import { activeRightPanelPage, openRightPanelPage, RightPanelSessionStore } from './right-panel-state.ts'

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

  it('文件按钮在所属工作区打开当前文件，同一路径的行号重复点击仍触发定位', async t => {
    const { window, document } = parseHTML('<html><body></body></html>')
    const globals = { window, document, IS_REACT_ACT_ENVIRONMENT: true }
    const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
    const root = createRoot(document.body)
    t.after(async () => {
      await act(async () => root.unmount())
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor)
        else Reflect.deleteProperty(globalThis, key)
      }
    })
    let state = new RightPanelSessionStore(null).get('test')
    async function click(projectDir: string, path: string, line?: number) {
      await act(async () => root.render(createElement(MarkdownFileLink, {
        baseDir: projectDir, path, line, onOpenFile: page => { state = openRightPanelPage(state, page) },
      }, '对照报告')))
      const button = document.querySelector('button')!
      assert.equal(button.textContent, '对照报告')
      button.click()
      const page = activeRightPanelPage(state)
      assert.ok(page?.kind === 'file' && page.source.kind === 'current')
      return page
    }
    assert.equal((await click('/srv/repo', './docs/结果.md')).previewMode, 'preview')
    const pinpoint = await click('/srv/repo', '/srv/repo/src/../docs/结果.md', 69)
    assert.equal(pinpoint.path, '/srv/repo/docs/结果.md')
    assert.equal(pinpoint.previewMode, 'code')
    assert.deepEqual(pinpoint.source, { kind: 'current', location: { line: 69 } })
    document.querySelector('button')!.click()
    const repeated = activeRightPanelPage(state)
    assert.ok(repeated?.kind === 'file' && repeated.source.kind === 'current' && pinpoint.source.kind === 'current')
    assert.notEqual(repeated.source.location, pinpoint.source.location)
    assert.equal(state.tabs.length, 1)
    assert.equal((await click('C:\\项目', 'src/../报告.md', 8)).path, 'C:\\项目\\报告.md')
    await click('C:\\项目', 'c:/项目/报告.md', 12)
    assert.equal(state.tabs.length, 2)
    assert.equal((await click('/srv/repo', 'docs/实验\\记录.md')).name, '实验\\记录.md')
    await click('/srv/repo', 'docs/实验/记录.md')
    assert.equal(state.tabs.length, 4)
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
