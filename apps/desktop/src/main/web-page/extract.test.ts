import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WEB_PAGE_MAX_LINE_CHARS } from '@whycode/core'
import { WEB_PAGE_MAX_CONTENT_CHARS } from './content.ts'
import { extractWebPage } from './extract.ts'

describe('网页正文确定性提取', () => {
  it('去除页面噪音与脚本，保留正文、绝对链接和 Markdown 表格', () => {
    const page = extractWebPage({
      kind: 'text',
      requestedUrl: 'https://example.com/start',
      finalUrl: 'https://example.com/articles/guide',
      contentType: 'text/html',
      text: `<!doctype html>
        <html><head><title>Example Guide</title></head><body>
          <nav>Navigation noise</nav>
          <main><article>
            <h1>Agent Guide</h1>
            <p>${'Useful article content. '.repeat(30)}</p>
            <p><a href="../docs">Official docs</a></p>
            <table><tr><th>Feature</th><th>Status</th></tr>
              <tr><td>Fetch</td><td>Ready</td></tr></table>
            <script>hostileInstruction()</script>
          </article></main>
        </body></html>`,
    })

    const markdown = page.lines.join('\n')
    assert.equal(page.title, 'Example Guide')
    assert.match(markdown, /Agent Guide/)
    assert.match(markdown, /\[Official docs\]\(https:\/\/example\.com\/docs\)/)
    assert.match(markdown, /\| Feature \| Status \|/)
    assert.doesNotMatch(markdown, /Navigation noise|hostileInstruction/)
    assert.equal(page.sourceTruncated, false)
  })

  it('纯文本和 Markdown 不经过 HTML 正文算法', () => {
    const page = extractWebPage({
      kind: 'text',
      requestedUrl: 'https://example.com/readme.md',
      finalUrl: 'https://example.com/readme.md',
      contentType: 'text/markdown',
      text: '# Title\n\n- item\n',
    })
    assert.deepEqual(page.lines, ['# Title', '', '- item'])
    assert.equal(page.title, undefined)
  })

  it('提取可展开的参数表和标签页，保留字面标识符及代码中的反斜杠', () => {
    const url = 'https://example.com/api'
    const { lines } = extractWebPage({
      kind: 'text', requestedUrl: url, finalUrl: url, contentType: 'text/html',
      text: `<html><body><main><h1>API</h1><p>${'Parameter documentation. '.repeat(12)}</p>
        <button aria-controls="params" aria-expanded="false">Show parameters</button>
        <section id="params" hidden aria-hidden="true" style="display: none">
          <table><tr><th>Parameter</th><th>Meaning</th></tr><tr><td>request_timeout</td><td>Seconds</td></tr></table>
        </section>
        <button role="tab" id="linux-tab">Linux</button>
        <div role="tabpanel" aria-labelledby="linux-tab" style="visibility:hidden">Linux terminal flags</div>
        <details><summary>Example</summary><p>Native details body</p></details>
        <p>Literal _label_ and <code>request\\_timeout</code></p>
        <aside hidden>unrelated hidden</aside><div aria-hidden="true">invisible</div>
        <div hidden><button aria-controls="unreachable">Hidden control</button></div>
        <p id="unreachable" hidden>unreachable panel</p>
        <script>script_payload</script><template>template_payload</template></main></body></html>`,
    })
    const text = lines.join('\n')
    assert.match(text, /\| request_timeout \| Seconds \|/)
    assert.match(text, /Linux terminal flags/)
    assert.match(text, /Native details body/)
    assert.ok(text.includes('\\_label\\_'))
    assert.ok(text.includes('`request\\_timeout`'))
    assert.doesNotMatch(text, /unrelated hidden|invisible|script_payload|template_payload|unreachable panel/)
  })

  it('仅采用 head 中同源同页的显式 Markdown 表示', () => {
    const url = 'https://example.com/docs/guide?version=2'
    const candidate = (head: string) => extractWebPage({
      kind: 'text', requestedUrl: url, finalUrl: url, contentType: 'text/html',
      text: `<html><head>${head}</head><body><link rel="alternate" type="text/markdown" href="guide.md?version=2"><main>Guide</main></body></html>`,
    }).markdownUrl
    const link = (href: string, type = 'text/markdown') => `<link rel="alternate" type="${type}" href="${href}">`
    for (const href of ['/llms.txt', '//external.example/docs/guide.md?version=2', '#self', 'guide.md?version=1']) {
      assert.equal(candidate(link(href)), undefined)
    }
    assert.equal(candidate(link('guide.md?version=2', 'application/rss+xml')), undefined)
    assert.equal(candidate('<!--' + link('guide.md?version=2') + '-->'), undefined)
    assert.equal(candidate(link('/llms.txt') + link('guide.md?version=2')), 'https://example.com/docs/guide.md?version=2')
    assert.equal(candidate(link('?version=2&amp;format=markdown')), url + '&format=markdown')
  })

  it('限制整页内容和单行长度，并显式记录源正文截断', () => {
    const page = extractWebPage({
      kind: 'text',
      requestedUrl: 'https://example.com/large.txt',
      finalUrl: 'https://example.com/large.txt',
      contentType: 'text/plain',
      text: 'A'.repeat(WEB_PAGE_MAX_CONTENT_CHARS + 10_000),
    })
    assert.equal(page.sourceTruncated, true)
    assert.equal(page.lines.every((line) => line.length <= WEB_PAGE_MAX_LINE_CHARS), true)
    assert.equal(page.lines.join('\n').length <= WEB_PAGE_MAX_CONTENT_CHARS, true)
  })
})
