import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Streamdown } from 'streamdown'
import { parseHTML } from 'linkedom'
import { documentImageComponents } from './markdown-document-images.ts'
import {
  markdownPluginsFor,
  markdownRemarkPlugins,
  markdownRehypePlugins,
  MARKDOWN_REMEND_OPTIONS,
  normalizeMathDelimiters,
  parseMarkdown,
} from './markdown-rendering.ts'

describe('Markdown 渲染', () => {
  it('文档配图使用文件自己的预览地址，保留主题候选、尺寸、外链徽章和刷新版本', () => {
    const base = 'whycode-preview://view/docs/README.md?v=2'
    const source = [
      '<picture><source media="(prefers-color-scheme: dark)" srcset="img/dark,a.png 1x, ../dark@2x.png 2x">',
      '<img width="600" src="img/light.png" srcset="img/small.png 400w, img/large.png 800w" sizes="100vw"></picture>',
      '',
      '[![Build](https://images.example.org/build.svg?branch=main#status)](https://example.org/actions)',
      '',
      '![另一个图](<目录/一 图.png>)',
    ].join('\n')
    const doc = parseHTML(renderedHtml(source, false, true, base)).document
    const picture = doc.querySelector('picture')!
    const img = picture.querySelector('img')!
    const dark = picture.querySelector('source')!
    assert.equal(img.getAttribute('src'), 'whycode-preview://view/docs/img/light.png?v=2')
    assert.equal(img.getAttribute('width'), '600')
    assert.equal(img.getAttribute('sizes'), '100vw')
    assert.equal(img.getAttribute('loading'), 'lazy')
    assert.equal(img.getAttribute('decoding'), 'async')
    assert.equal(img.getAttribute('srcSet'), 'whycode-preview://view/docs/img/small.png?v=2 400w, whycode-preview://view/docs/img/large.png?v=2 800w')
    assert.equal(dark.getAttribute('media'), '(prefers-color-scheme: dark)')
    assert.equal(dark.getAttribute('srcSet'), 'whycode-preview://view/docs/img/dark,a.png?v=2 1x, whycode-preview://view/dark@2x.png?v=2 2x')
    const badge = doc.querySelector('a img')!
    const url = new URL(badge.getAttribute('src')!)
    assert.equal(url.host, 'view')
    assert.equal(url.pathname, '/')
    assert.equal(url.searchParams.get('image'), 'https://images.example.org/build.svg?branch=main')
    assert.equal(url.hash, '#status')
    assert.equal(badge.parentElement?.getAttribute('href'), 'https://example.org/actions')
    assert.equal(decodeURI(doc.querySelector('img[alt="另一个图"]')!.getAttribute('src')!), 'whycode-preview://view/docs/目录/一 图.png?v=2')
    assert.doesNotMatch(renderedHtml(source, false, true), /whycode-preview:/u)
  })

  it('只交付当前文档的图片资源，过滤无效候选并保留 HTML 净化', () => {
    const source = '<picture><source srcset="file:///outside.png 1x, whycode-preview://other/x.png 2x, img/ok.png 3x">' +
      '<img src="file:///outside.png" alt="替代说明" onerror="alert(1)"></picture>\n\n' +
      '<wc-document-image src="https://example.org/forged.png"></wc-document-image>'
    const doc = parseHTML(renderedHtml(source, false, true, 'whycode-preview://view/docs/readme.md')).document
    assert.equal(doc.querySelector('source')?.getAttribute('srcSet'), 'whycode-preview://view/docs/img/ok.png 3x')
    assert.equal(doc.querySelectorAll('img').length, 1)
    assert.equal(doc.querySelector('picture img')?.hasAttribute('src'), false)
    assert.doesNotMatch(doc.toString(), /file:\/\/\/outside|whycode-preview:\/\/other|onerror=|forged\.png/u)
  })

  it('同段的近似值与数值范围不会跨正文形成删除线', () => {
    const source = '快速恢复的窗口约为（~90 ms）；**中断时间延长到 100 ms** 后，需要 6~7 秒完成重训练。'
    for (const streaming of [true, false]) {
      const document = renderedDocument(source, streaming)
      assert.equal(document.querySelectorAll('del').length, 0)
      assert.equal(document.body.textContent, source.replaceAll('**', ''))
      assert.equal(document.querySelector('[data-streamdown="strong"]')?.textContent, '中断时间延长到 100 ms')
    }
    assert.doesNotMatch(JSON.stringify(parseMarkdown(source)), /"type":"delete"/u)
  })

  it('逐段接收单波浪号时保持原文，双波浪号仍支持中英文删除线', () => {
    const source = '大约 ~90 ms，范围 6~7 秒；保留~~“旧方案”~~，以及 ~~obsolete~~。'
    const ordinary = source.slice(0, source.indexOf('；'))
    for (let end = 1; end <= ordinary.length; end++) {
      const document = renderedDocument(ordinary.slice(0, end), true)
      assert.equal(document.querySelectorAll('del').length, 0, `流式位置 ${end}`)
      assert.equal(document.body.textContent, ordinary.slice(0, end).trimEnd())
    }
    for (const streaming of [true, false]) {
      const document = renderedDocument(source, streaming)
      assert.deepEqual([...document.querySelectorAll('del')].map(node => node.textContent), ['“旧方案”', 'obsolete'])
      assert.equal(document.body.textContent, source.replaceAll('~~', ''))
    }
    assert.match(JSON.stringify(parseMarkdown('保留~~“旧方案”~~')), /"type":"delete"/u)
  })

  it('单波浪号配置不改写代码、转义、链接和表格中的字面值', () => {
    const source = [
      '代码 `~90 ms；6~7 秒`，转义 \\~原文\\~，[~90 ms；6~7 秒](https://example.com/~user)。',
      '',
      '| 近似值 | 范围 |',
      '| --- | --- |',
      '| ~90 ms | 6~7 秒 |',
    ].join('\n')
    for (const streaming of [true, false]) {
      const document = renderedDocument(source, streaming)
      assert.equal(document.querySelectorAll('del').length, 0)
      assert.equal(document.querySelector('code')?.textContent, '~90 ms；6~7 秒')
      assert.equal(document.querySelector('a')?.getAttribute('href'), 'https://example.com/~user')
      assert.match(document.body.textContent, /转义 ~原文~/u)
      assert.deepEqual([...document.querySelectorAll('td')].map(node => node.textContent), ['~90 ms', '6~7 秒'])
    }
  })

  it('美元金额不跨加粗边界形成公式，保留引用与整句文字', () => {
    const source = '计价标注为 **$42 每 10 亿（Billion）输入 Token**（即 $0.042/M tokens），且输出不计费 '
      + '[官网](https://example.com/pricing "whycode:source")。'
    for (const streaming of [true, false]) {
      const document = renderedDocument(source, streaming)
      assert.equal(document.querySelectorAll('.katex').length, 0)
      assert.equal(document.querySelector('[data-streamdown="strong"]')?.textContent, '$42 每 10 亿（Billion）输入 Token')
      assert.equal(document.body.textContent, '计价标注为 $42 每 10 亿（Billion）输入 Token（即 $0.042/M tokens），且输出不计费 官网。')
      assert.equal(document.querySelector('a')?.getAttribute('data-source-citation-url'), 'https://example.com/pricing')
    }
  })

  it('同段多个金额、范围和紧邻数字的美元符号保持普通文本', () => {
    for (const source of [
      '$0.000081 vs $0.01388', '$20,000–$30,000', 'US$5 / C$10 / US$20',
      '$5和$10', '$ 5 与 $ 10', '$x$2', '$ x$', '$y $',
    ]) {
      const document = renderedDocument(source, false)
      assert.equal(document.querySelectorAll('.katex').length, 0, source)
      assert.equal(document.body.textContent, source)
    }
  })

  it('金额与实际公式混排，数字公式和显式 TeX 均不受影响', () => {
    const source = String.raw`费用 $5 和 $10；公式 $x+1$、$2 \times 4$、$1.25$；显式 \( x + 1 \)2，以及 \(\text{price: \$5}\)。`
    const document = renderedDocument(source, false)
    assert.deepEqual([...document.querySelectorAll('.katex annotation')].map(node => node.textContent), [
      'x+1', String.raw`2 \times 4`, '1.25', ' x + 1 ', String.raw`\text{price: \$5}`,
    ])
    assert.match(document.body.textContent, /费用 \$5 和 \$10/u)
  })

  it('转义美元、代码、链接地址和标题不经过金额替换', () => {
    const source = '转义 \\$5 和 \\$10；代码 `$x$ 与 $20`；[价格 $5 与 $10](https://example.com/$5/$10 "费用 $5 与 $10")。'
    const document = renderedDocument(source, false)
    assert.equal(document.querySelectorAll('.katex').length, 0)
    assert.equal(document.querySelector('code')?.textContent, '$x$ 与 $20')
    assert.equal(document.querySelector('a')?.getAttribute('href'), 'https://example.com/$5/$10')
    assert.equal(document.querySelector('a')?.getAttribute('title'), '费用 $5 与 $10')
    assert.equal(normalizeMathDelimiters(source), source)
  })

  it('显式行内 TeX 保持字面位置，支持换行并尊重反斜杠转义', () => {
    const source = String.raw`字面量 \\(x+1\\)，未闭合 \(x，公式 \(a\\) 也未闭合。`
    assert.equal(renderedDocument(source, false).querySelectorAll('.katex').length, 0)
    const multiline = renderedDocument('公式 \\(x +\n y\\)；价格 $5 和 $10。', false)
    assert.equal(multiline.querySelectorAll('.katex').length, 1)
    assert.equal(multiline.querySelector('.katex annotation')?.textContent, 'x +\n y')
  })

  it('清洗后只标注显式 Markdown 引用，HTML 和同址普通链接不能冒充', () => {
    const source = '[文档](https://example.com/docs "whycode:source") '
      + '[普通链接](https://example.com/docs)\n\n'
      + '<a href="https://example.com/docs" title="whycode:source" data-source-citation-url="https://example.com/docs">HTML</a>'
    for (const streaming of [true, false]) {
      const document = renderedDocument(source, streaming)
      const links = [...document.querySelectorAll('a')]
      assert.deepEqual(links.map(link => link.getAttribute('data-source-citation-url')), ['https://example.com/docs', null, null])
    }
  })
  it('会话文件链接保留清洗前的路径、行号和显示名称', () => {
    const source = '[**实验对照**](</srv/project/reports/5 秒与 10 秒.md>) '
      + '[入口](src/main.ts:24:3) [说明](<C:/工作/test%231.md#L7-L12>) [日志](notes.md) '
      + '[行尾](./notes%3A24) [无效行](./app.ts#L0) [范围](./app.ts:31-35)'
    for (const streaming of [true, false]) {
      const doc = renderedDocument(source, streaming)
      const links = [...doc.querySelectorAll('a[data-file-path]')]
      assert.equal(links[0]?.textContent, '实验对照')
      assert.deepEqual(links.map(link => [link.getAttribute('data-file-path'), link.getAttribute('data-file-line')]), [
        ['/srv/project/reports/5 秒与 10 秒.md', null], ['src/main.ts', '24'], ['C:/工作/test#1.md', '7'],
        ['notes.md', null], ['./notes:24', null], ['./app.ts', null], ['./app.ts', '31'],
      ])
      assert.deepEqual(links.map(link => link.getAttribute('data-file-end-line')), [null, null, '12', null, null, null, '35'])
    }
    const definition = renderedDocument('[报告][r]\n\n[r]: <./目录/报告.md#L3>', false)
    assert.equal(definition.querySelector('[data-file-path]')?.getAttribute('data-file-line'), '3')
  })
  it('裸目录与显式相对目录在流式和定稿时都保留链接文字和原始目标', () => {
    const source = '[**源码目录**](Coyote/) [同级](./hw/) [上级](../) [项目](</srv/my project/>)'
    for (const streaming of [true, false]) {
      const doc = renderedDocument(source, streaming)
      assert.equal(doc.body.textContent, '源码目录 同级 上级 项目')
      assert.deepEqual([...doc.querySelectorAll('a[data-file-path]')].map(link => link.getAttribute('data-file-path')),
        ['Coyote/', './hw/', '../', '/srv/my project/'])
    }
  })
  it('文件入口只接受完整的 Markdown 文件链接，保持网页、来源和 HTML 的既有语义', () => {
    const source = [
      '[网页](https://example.com/report.md#L2) [来源](https://example.com "whycode:source")',
      '[站点](//example.com/a/) [锚](#L3) [脚本](javascript:24) [协议](file:///c:/a/) [首页](https://example.com/)',
      '`[示例](./a.ts:3)` <a href="#workspace-file" data-file-path="/a.ts">HTML</a>',
    ].join('\n\n')
    for (const streaming of [true, false]) {
      const doc = renderedDocument(source, streaming)
      assert.equal(doc.querySelector('[data-file-path]'), null)
      assert.equal(doc.querySelector('a')?.getAttribute('href'), 'https://example.com/report.md#L2')
      assert.equal(doc.querySelector('[data-source-citation-url]')?.textContent, '来源')
    }
    const incomplete = renderedDocument('[入口](./src/main.ts#L', true)
    assert.equal(incomplete.body.textContent, '入口')
    assert.equal(incomplete.querySelector('a'), null)
  })
  it('公式规范化保留链接标题、定义和嵌套代码中的转义字面量', () => {
    const link = '[规范 \\[正式版\\]](https://example.com/docs "whycode:source")'
    const definition = '[docs]: https://example.com/\\(name\\) "标题"'
    const nestedCode = '> ```md\n> \\(example\\)\n> ```'
    for (const text of [link, definition, nestedCode]) assert.equal(normalizeMathDelimiters(text), text)
    assert.equal(normalizeMathDelimiters(link + '\n\n\\(x+1\\)'), link + '\n\n\\(x+1\\)')
  })
  it('流式与定稿阶段复用各自稳定的插件配置', () => {
    assert.equal(markdownPluginsFor(false), markdownPluginsFor(false))
    assert.equal(markdownPluginsFor(true), markdownPluginsFor(true))
    assert.notEqual(markdownPluginsFor(false), markdownPluginsFor(true))
    assert.equal(markdownRemarkPlugins(), markdownRemarkPlugins())
  })

  it('定稿后按标准 Markdown 扩展识别并隐藏 YAML frontmatter', () => {
    const source = [
      '---',
      'name: explain-code-from-evidence',
      'description: 用中文解释代码',
      '---',
      '',
      '# 基于证据解释代码',
    ].join('\n')

    const document = renderedDocument(source, false)

    assert.equal(document.querySelectorAll('h1').length, 1)
    assert.equal(document.querySelector('h1')?.textContent, '基于证据解释代码')
    assert.equal(document.querySelector('h2'), null)
    assert.doesNotMatch(document.body.textContent, /name:|description:/u)
  })

  it('定稿扩展保留 Streamdown 默认的 GFM 表格能力', () => {
    const source = [
      '| 运行精度 | 权重占用 | 推荐显存 | 推荐方案 |',
      '| :--- | :--- | :--- | :--- |',
      '| **Q4 量化**<br>*家用推荐* | 16 GB | **24 GB** | 单卡<br>或双卡 |',
    ].join('\n')

    const document = renderedDocument(source, false)

    assert.equal(document.querySelectorAll('table').length, 1)
    assert.equal(document.querySelectorAll('th').length, 4)
    assert.equal(document.querySelectorAll('tbody tr').length, 1)
    assert.equal(document.querySelectorAll('tbody br').length, 2)
    assert.doesNotMatch(document.body.textContent, /\|\s*:---/u)
  })

  it('流式阶段不加载 frontmatter 扩展', () => {
    const source = '---\nname: demo\n---\n\n# 正文'
    const document = renderedDocument(source, true)

    assert.match(document.body.textContent, /name: demo/u)
  })

  it('正文中的分隔线仍按普通 Markdown 渲染', () => {
    const document = renderedDocument('前文\n\n---\n\n后文', false)

    assert.equal(document.querySelectorAll('hr').length, 1)
    assert.deepEqual(
      [...document.querySelectorAll('p')].map((paragraph) => paragraph.textContent),
      ['前文', '后文'],
    )
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

    assert.equal(normalizeMathDelimiters(source), source)
    assert.equal(document.querySelectorAll('.katex-display').length, 1)
  })

  it('把标准 TeX 行内与块级定界符送入同一 KaTeX 链路', () => {
    const source = String.raw`假设当前已经有 \(T\) 个历史 token。

\[
K,V \in \mathbb{R}^{T \times d}
\]

\[(1 \times d) \cdot (d \times T)\]`
    const normalized = normalizeMathDelimiters(source)
    const document = renderedDocument(source, false)
    const formulas = [...document.querySelectorAll('.katex annotation')]
      .map((node) => node.textContent)

    assert.deepEqual(formulas, [
      'T',
      String.raw`K,V \in \mathbb{R}^{T \times d}`,
      String.raw`(1 \times d) \cdot (d \times T)`,
    ])
    assert.equal(document.querySelectorAll('.katex-display').length, 2)
    assert.equal(normalizeMathDelimiters(normalized), normalized)
  })

  it('块级 TeX 定界符即使附着在段落中也保持 display 语义', () => {
    const document = renderedDocument(String.raw`前文 \[x^2 + y^2\] 后文`, false)

    assert.equal(document.querySelectorAll('.katex-display').length, 1)
    assert.deepEqual(
      [...document.querySelectorAll('p')].map((paragraph) => paragraph.textContent),
      ['前文', '后文'],
    )
  })

  it('公式定界符规范化不进入围栏代码、行内代码或转义字面量', () => {
    const source = [
      '正文 \\(x^2\\)，代码 `\\(inline\\)`，字面量 \\\\(literal\\\\)。',
      '',
      '``\\[still inline code\\]``',
      '',
      '```tex',
      '\\[block code\\]',
      '\\(inline code\\)',
      '```',
    ].join('\n')
    const normalized = normalizeMathDelimiters(source)
    const document = renderedDocument(source, false)

    assert.equal(document.querySelectorAll('.katex').length, 1)
    assert.deepEqual(
      [...document.querySelectorAll('code')].map((node) => node.textContent),
      [
        String.raw`\(inline\)`,
        String.raw`\[still inline code\]`,
        String.raw`\[block code\]\(inline code\)`,
      ],
    )
    assert.match(normalized, /\\\\\(literal\\\\\)/u)
  })

  it('未闭合的 TeX 定界符保持原文，等待后续流片段补全', () => {
    const source = String.raw`前文 \(x + 1，后文 \[y = 2`

    assert.equal(normalizeMathDelimiters(source), source)
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
    const normalized = normalizeMathDelimiters(source)
    const document = renderedDocument(source, false)
    const formulas = [...document.querySelectorAll('.katex annotation')]
      .map((node) => node.textContent)

    assert.equal(document.querySelectorAll('.katex-display').length, 3)
    assert.equal(document.querySelectorAll('.katex-error').length, 0)
    assert.equal(normalizeMathDelimiters(normalized), normalized)
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

function renderedHtml(source: string, streaming: boolean, renderMath: boolean, documentUrl?: string) {
  const renderedSource = renderMath ? normalizeMathDelimiters(source) : source
  return renderToStaticMarkup(createElement(
    Streamdown,
    {
      mode: streaming ? 'streaming' : 'static',
      plugins: markdownPluginsFor(renderMath),
      remend: MARKDOWN_REMEND_OPTIONS,
      remarkPlugins: markdownRemarkPlugins(streaming),
      rehypePlugins: markdownRehypePlugins(documentUrl),
      components: documentUrl ? documentImageComponents : undefined,
      linkSafety: { enabled: false },
    },
    renderedSource,
  ))
}
