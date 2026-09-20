import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findSourceCapsule,
  sourceCitations,
  sourceKindForUrl,
} from './markdown-sources.ts'
import { parseHTML } from 'linkedom'
import { parseMarkdown } from './markdown-rendering.ts'

describe('Markdown 来源语义', () => {
  it('只识别明确引用标记，普通链接即使同址或名为来源也保持原义', () => {
    const tree = parseMarkdown('[**文档** `v2`](https://EXAMPLE.com:443/report#results "whycode:source") '
      + '[来源](https://example.com/report#results) [官网](https://example.com/report#results "官网")')
    assert.deepEqual(sourceCitations(tree).map(citation => citation.source), [
      { title: '文档 v2', url: 'https://example.com/report#results' },
    ])
  })

  it('标准解析保留转义、括号、片段及定义式引用，未使用的定义不产生来源', () => {
    const tree = parseMarkdown('[文档 \\[正式版\\]](<https://example.com/a(b)?q=1#part> \'whycode:source\')\n\n'
      + '[说明][docs]\n\n[docs]: https://example.com/docs "whycode:source"\n'
      + '[unused]: https://example.com/unused "whycode:source"')
    assert.deepEqual(sourceCitations(tree).map(citation => citation.source), [
      { title: '文档 [正式版]', url: 'https://example.com/a(b)?q=1#part' },
      { title: '说明', url: 'https://example.com/docs' },
    ])
  })

  it('引用标题与正文使用相同的中文强调语义', () => {
    const tree = parseMarkdown('[一个**“工具箱”**：说明](https://example.com/docs "whycode:source")')
    assert.deepEqual(sourceCitations(tree).map(citation => citation.source.title), ['一个“工具箱”：说明'])
  })

  it('代码、数学、frontmatter、HTML、图片和不完整链接不成为引用', () => {
    const link = '[文档](https://example.com/docs "whycode:source")'
    for (const text of ['`' + link + '`', '```md\n' + link + '\n```', '    ' + link,
      '$' + link + '$', '$$\n' + link + '\n$$', '---\nexample: ' + link + '\n---',
      '<a href="https://example.com/docs" title="whycode:source">文档</a>', '!' + link,
      '[文档](https://example.com/docs "whycode:source"']) {
      assert.deepEqual(sourceCitations(parseMarkdown(text)), [], text)
    }
  })

  it('缺少标题、凭据及非网页地址不生成来源', () => {
    for (const link of ['[](https://example.com "whycode:source")',
      '[文档](https://user:secret@example.com "whycode:source")',
      '[文档](javascript:alert%281%29 "whycode:source")',
      '[文档](file:///C:/a.html "whycode:source")', '[文档](./a.html "whycode:source")']) {
      assert.deepEqual(sourceCitations(parseMarkdown(link)), [])
    }
  })

  it('按稳定 URL 特征选择来源图标', () => {
    assert.equal(sourceKindForUrl('https://github.com/org/repo'), 'git')
    assert.equal(sourceKindForUrl('https://arxiv.org/abs/1234.5678'), 'document')
    assert.equal(sourceKindForUrl('https://example.com/report.pdf'), 'document')
    assert.equal(sourceKindForUrl('https://example.com/news'), 'web')
  })

  it('正文引用可跨 Markdown block 定位同一回答中的来源胶囊', () => {
    const { document } = parseHTML(`
      <section data-source-scope>
        <div id="body"><a data-source-url="https://example.com/report">来源</a></div>
        <div><button data-source-capsule-url="https://example.com/report">报告</button></div>
        <div><button data-source-capsule-url="https://example.com/report#results">报告结论</button></div>
      </section>
      <button data-source-capsule-url="https://example.com/report">其他回答</button>
    `)
    const body = document.querySelector('#body')!
    assert.equal(
      findSourceCapsule(body, 'https://example.com/report')?.textContent,
      '报告',
    )
    assert.equal(findSourceCapsule(body, 'https://example.com/report#results')?.textContent, '报告结论')
    assert.equal(findSourceCapsule(body, 'https://example.com/missing'), null)
  })
})
