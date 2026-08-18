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

describe('Markdown 渲染', () => {
  it('流式与定稿阶段复用各自稳定的插件配置', () => {
    assert.equal(markdownPluginsFor(false), markdownPluginsFor(false))
    assert.equal(markdownPluginsFor(true), markdownPluginsFor(true))
    assert.notEqual(markdownPluginsFor(false), markdownPluginsFor(true))
  })

  it('流式与定稿阶段都按 CJK 边界渲染强调语法', () => {
    const source = 'GitHub Actions 是**“按需触发”**的，每个 YAML 文件都是一个**完全独立的工作流**。'

    for (const streaming of [true, false]) {
      const document = renderedDocument(source, streaming)
      const emphasized = [...document.querySelectorAll('[data-streamdown="strong"]')]
        .map((node) => node.textContent)

      assert.deepEqual(emphasized, ['“按需触发”', '完全独立的工作流'])
      assert.equal(
        document.body.textContent,
        'GitHub Actions 是“按需触发”的，每个 YAML 文件都是一个完全独立的工作流。',
      )
    }
  })

  it('正确处理中文引号、括号和全角标点相邻的多个强调片段', () => {
    const source = [
      '一个**“工具箱”**：里面',
      '单元测试（Unit Test）中的**“单元（Unit）”**，指的是软件中**最小的可测试部件**。',
      '单元测试最大的特点是**“孤立测试”**（把被测对象从外部环境中剥离出来）。',
    ].join('\n\n')
    const document = renderedDocument(source, false)

    assert.deepEqual(
      [...document.querySelectorAll('[data-streamdown="strong"]')]
        .map((node) => node.textContent),
      ['“工具箱”', '“单元（Unit）”', '最小的可测试部件', '“孤立测试”'],
    )
    assert.doesNotMatch(document.body.textContent, /\*\*/u)
  })

  it('代码中的强调标记保持原文', () => {
    const document = renderedDocument(
      '代码：`一个**“工具箱”**：里面`；正文：一个**“工具箱”**：里面。',
      false,
    )

    assert.equal(document.querySelector('code')?.textContent, '一个**“工具箱”**：里面')
    assert.deepEqual(
      [...document.querySelectorAll('[data-streamdown="strong"]')]
        .map((node) => node.textContent),
      ['“工具箱”'],
    )
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
