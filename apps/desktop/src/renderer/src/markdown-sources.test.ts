import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  findPresentedSource,
  findSourceCapsule,
  normalizeSourceUrl,
  sourceKindForUrl,
} from './markdown-sources.ts'
import { parseHTML } from 'linkedom'

describe('Markdown 来源语义', () => {
  it('只按本回答声明的完整 URL 识别引用，与正文链接文字无关', () => {
    const source = { title: '完整文章标题', url: 'https://EXAMPLE.com:443/report#results' }
    assert.equal(findPresentedSource([source], 'https://example.com/report#results'), source)
    for (const href of ['https://example.com/report', 'https://example.com/report#other',
      'https://example.com/Report#results', 'https://example.com/elsewhere',
      'https://user@example.com/report#results', 'javascript:alert(1)', undefined]) {
      assert.equal(findPresentedSource([source], href), undefined)
    }
    assert.equal(findPresentedSource(undefined, source.url), undefined)
    assert.equal(findPresentedSource([], source.url), undefined)
  })

  it('对安全外链做最小归一化，不丢失来源片段身份', () => {
    assert.equal(normalizeSourceUrl('https://example.com/a#part'), 'https://example.com/a#part')
    assert.equal(normalizeSourceUrl('https://user@example.com/a'), null)
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
