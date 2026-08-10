import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  externalSourcesFromList,
  findSourceCapsule,
  isExternalSourceList,
  isInlineSourceLabel,
  normalizeSourceUrl,
  sourceKindForUrl,
} from './markdown-sources.ts'
import { parseHTML } from 'linkedom'

describe('Markdown 来源语义', () => {
  it('只把每项恰好一个外链的列表识别为来源列表', () => {
    assert.equal(isExternalSourceList(list(
      item(link('https://example.com/a')),
      item(paragraph(link('https://example.com/b'))),
    )), true)
    assert.equal(isExternalSourceList(list(
      item(link('https://example.com/a'), text(' （注解）')),
    )), false)
    assert.equal(isExternalSourceList(list(item(link('/relative')))), false)
  })

  it('从来源列表提取完整标题、域名和稳定类型', () => {
    assert.deepEqual(externalSourcesFromList(list(
      item(link('https://www.example.com/report.pdf', '完整报告标题')),
      item(paragraph(link('https://github.com/org/repo', '项目仓库'))),
    )), [
      {
        title: '完整报告标题',
        url: 'https://www.example.com/report.pdf',
        domain: 'example.com',
        kind: 'document',
      },
      {
        title: '项目仓库',
        url: 'https://github.com/org/repo',
        domain: 'github.com',
        kind: 'git',
      },
    ])
  })

  it('对正文来源标签和安全外链做最小归一化', () => {
    assert.equal(isInlineSourceLabel(' 来源 '), true)
    assert.equal(isInlineSourceLabel('Source'), true)
    assert.equal(isInlineSourceLabel('官方文档'), false)
    assert.equal(normalizeSourceUrl('https://example.com/a#part'), 'https://example.com/a')
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
      </section>
      <button data-source-capsule-url="https://example.com/report">其他回答</button>
    `)
    const body = document.querySelector('#body')!
    assert.equal(
      findSourceCapsule(body, 'https://example.com/report')?.textContent,
      '报告',
    )
    assert.equal(findSourceCapsule(body, 'https://example.com/missing'), null)
  })
})

function list(...children: unknown[]) {
  return element('ul', children)
}

function item(...children: unknown[]) {
  return element('li', children)
}

function paragraph(...children: unknown[]) {
  return element('p', children)
}

function link(href: string, title = 'title') {
  return { ...element('a', [text(title)]), properties: { href } }
}

function text(value: string) {
  return { type: 'text', value }
}

function element(tagName: string, children: unknown[]) {
  return { type: 'element', tagName, children }
}
