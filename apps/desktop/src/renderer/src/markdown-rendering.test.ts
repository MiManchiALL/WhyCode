import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { parseHTML } from 'linkedom'
import {
  markdownPluginsFor,
  normalizeDisplayMathFences,
} from './markdown-rendering.ts'

describe('Markdown 数学渲染', () => {
  it('只在回复定稿后启用引用稳定的数学插件', () => {
    assert.equal(markdownPluginsFor(false), undefined)
    assert.equal(markdownPluginsFor(true), markdownPluginsFor(true))
  })

  it('定稿后渲染行内公式和模型常见的同一行矩阵公式', () => {
    const source = String.raw`假设一个 $2 \times 4$ 的矩阵：

$$\begin{bmatrix} 1 & 2 & 3 & 4 \\ 5 & 6 & 7 & 8 \end{bmatrix}$$`
    const document = renderedDocument(source, false)
    const formulas = [...document.querySelectorAll('.katex annotation')]
      .map((node) => node.textContent)

    assert.deepEqual(formulas, [
      String.raw`2 \times 4`,
      String.raw`\begin{bmatrix} 1 & 2 & 3 & 4 \\ 5 & 6 & 7 & 8 \end{bmatrix}`,
    ])
    assert.equal(document.querySelectorAll('.katex').length, 2)
    assert.equal(document.querySelectorAll('.katex-display').length, 1)
  })

  it('按标准多行分隔符渲染块级公式', () => {
    const source = '$$\nE = mc^2\n$$'
    const document = renderedDocument(source, false)

    assert.equal(normalizeDisplayMathFences(source), source)
    assert.equal(document.querySelectorAll('.katex-display').length, 1)
  })

  it('规范化真实模型常见的同行与跨行块公式而不丢失数学环境', () => {
    const source = String.raw`$$\mathcal{L}_{\text{SM}} = \mathcal{L}_{\text{gauge}} + \mathcal{L}_{\text{fermion}}$$

$$\begin{aligned}
\mathcal{L}_{\text{SM}} = & -\frac{1}{4} G_{\mu\nu}^A G^{A\mu\nu} \\
& + \sum_{\text{generations}} \bar{Q}_L i \gamma^\mu D_\mu Q_L \\
& + |D_\mu \Phi|^2 - V(\Phi)
\end{aligned}$$

1. 规范场：
   $$G_{\mu\nu}^A = \partial_\mu G_\nu^A - \partial_\nu G_\mu^A$$

$Y_u$ 为 $3 \times 3$ 的复矩阵。`
    const normalized = normalizeDisplayMathFences(source)
    const document = renderedDocument(source, false)
    const formulas = [...document.querySelectorAll('.katex annotation')]
      .map((node) => node.textContent)

    assert.equal(document.querySelectorAll('.katex-display').length, 3)
    assert.equal(document.querySelectorAll('.katex-error').length, 0)
    assert.equal(normalizeDisplayMathFences(normalized), normalized)
    assert.ok(formulas.some((formula) => formula?.includes(String.raw`\begin{aligned}`)))
    assert.ok(formulas.some((formula) => formula?.includes(String.raw`G_{\mu\nu}^A`)))
    assert.equal((document.body.textContent.match(/\$\$/gu) ?? []).length, 0)
  })

  it('不把段落内部的双美元行内公式改成块级公式', () => {
    const document = renderedDocument('比较 $$x^2$$ 与 $y^2$。', false)

    assert.equal(document.querySelectorAll('.katex').length, 2)
    assert.equal(document.querySelector('.katex-display'), null)
  })

  it('流式阶段保留 TeX 原文而不提前排版', () => {
    const source = String.raw`矩阵 $$\begin{bmatrix} 1 & 2 \\ 3 & 4 \end{bmatrix}$$`
    const document = renderedDocument(source, true)

    assert.equal(document.querySelector('.katex'), null)
    assert.match(document.body.textContent, /begin\{bmatrix\}/u)
  })

  it('不把代码块中的 TeX 当作公式', () => {
    const source = [
      '```',
      '$$E = mc^2$$',
      '```',
      '',
      '~~~tex',
      '$$F = ma$$',
      '~~~~',
      '',
      '$$x^2$$',
    ].join('\n')
    const document = renderedDocument(source, false)

    assert.equal(document.querySelectorAll('.katex-display').length, 1)
    assert.deepEqual(
      [...document.querySelectorAll('pre code')].map((node) => node.textContent),
      ['$$E = mc^2$$', '$$F = ma$$'],
    )
  })

  it('非法 TeX 命令保持可见且不阻断整段渲染', () => {
    const document = renderedDocument(String.raw`前文 $\notACommand{x}$ 后文`, false)

    assert.match(document.querySelector('.katex annotation')?.textContent ?? '', /notACommand/u)
    assert.match(document.body.textContent, /前文.*后文/u)
  })

  it('回复被停止时保留未闭合公式原文', () => {
    const html = renderedHtml(
      String.raw`$$\begin{bmatrix} 1 & 2 \\`,
      false,
      false,
    )

    assert.ok(html.length < 100_000)
    assert.match(html, /begin\{bmatrix\}/u)
  })
})

function renderedDocument(source: string, streaming: boolean) {
  const html = renderedHtml(source, streaming, !streaming)
  return parseHTML(`<!doctype html><html><body>${html}</body></html>`).document
}

function renderedHtml(source: string, streaming: boolean, renderMath: boolean) {
  const renderedSource = renderMath ? normalizeDisplayMathFences(source) : source
  return renderToStaticMarkup(createElement(
    Streamdown,
    {
      mode: streaming ? 'streaming' : 'static',
      plugins: markdownPluginsFor(renderMath),
    },
    renderedSource,
  ))
}
