import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { WEB_PAGE_MAX_LINE_CHARS } from '@whycode/core'
import { WEB_PAGE_MAX_CONTENT_CHARS, extractWebPage } from './extract.ts'

describe('网页正文确定性提取', () => {
  it('去除页面噪音与脚本，保留正文、绝对链接和 Markdown 表格', () => {
    const page = extractWebPage({
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
      requestedUrl: 'https://example.com/readme.md',
      finalUrl: 'https://example.com/readme.md',
      contentType: 'text/markdown',
      text: '# Title\n\n- item\n',
    })
    assert.deepEqual(page.lines, ['# Title', '', '- item'])
    assert.equal(page.title, undefined)
  })

  it('限制整页内容和单行长度，并显式记录源正文截断', () => {
    const page = extractWebPage({
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
