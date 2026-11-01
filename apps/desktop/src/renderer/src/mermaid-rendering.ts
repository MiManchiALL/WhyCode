import type { MermaidConfig } from 'mermaid'

const MERMAID_MAX_SOURCE_CHARS = 20_000
const MERMAID_MAX_LINES = 500
const MERMAID_MAX_EDGES = 200
const FLOWCHART_PADDING = 10

let queue: Promise<unknown> = Promise.resolve()
let nextId = 0

export function mermaidSourceTooLarge(source: string): boolean {
  return source.length > MERMAID_MAX_SOURCE_CHARS || source.split('\n', MERMAID_MAX_LINES + 1).length > MERMAID_MAX_LINES
}

/** Mermaid 需要 DOM 测量且共享配置；仅串行处理可见的定稿图表，不缓存源码或 SVG。 */
export function renderMermaid(source: string, signal: AbortSignal): Promise<string> {
  const task = queue.then(async () => {
    signal.throwIfAborted()
    if (mermaidSourceTooLarge(source)) throw new Error('图表过大，已显示源码')
    const { default: mermaid } = await import('mermaid')
    signal.throwIfAborted()
    const style = getComputedStyle(document.documentElement)
    const config: MermaidConfig = {
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: MERMAID_MAX_SOURCE_CHARS,
      maxEdges: MERMAID_MAX_EDGES,
      // 图片展示不支持 foreignObject；使用 SVG 原生文字以支持缩放与导出。
      htmlLabels: false,
      flowchart: { htmlLabels: false, wrappingWidth: 400, padding: FLOWCHART_PADDING, nodeSpacing: 32, rankSpacing: 36, curve: 'step' },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'],
      theme: 'base',
      // 分支背景默认仅留 2px。几何样式在 Mermaid 测量前生效，让标签与矩形节点共用留白并参与布局。
      themeCSS: `.edgeLabel rect.background {
        opacity: 1; stroke: #d9d9d9 !important; stroke-width: 1px; rx: 8px; ry: 8px;
        x: calc(attr(x px) - ${FLOWCHART_PADDING * 2 - 2}px); y: calc(attr(y px) - ${FLOWCHART_PADDING - 2}px);
        width: calc(attr(width px) + ${(FLOWCHART_PADDING * 2 - 2) * 2}px); height: calc(attr(height px) + ${(FLOWCHART_PADDING - 2) * 2}px);
      }
        .edgeLabel .label text { fill: #292a27; }`,
      fontFamily: style.getPropertyValue('--wc-font-family').trim(),
      themeVariables: {
        fontSize: style.getPropertyValue('--wc-mermaid-font-size').trim(),
        background: '#ffffff', primaryColor: '#f5f6f4', primaryTextColor: '#292a27',
        primaryBorderColor: '#c5cac1', lineColor: '#858b80', secondaryColor: '#edf1eb',
        tertiaryColor: '#fafbf9', noteBkgColor: '#f5f6f4', noteTextColor: '#292a27',
        edgeLabelBackground: '#ffffff',
      },
    }
    mermaid.initialize(config)
    const container = document.createElement('div')
    container.className = 'wc-mermaid-measure'
    document.body.appendChild(container)
    try {
      const { svg } = await mermaid.render(`wc-mermaid-${++nextId}`, source, container)
      signal.throwIfAborted()
      // 固定 SVG 的固有尺寸，防止 width="100%" 在 img 中退成 300×150。
      const image = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement
      const viewBox = image.getAttribute('viewBox')?.split(/[\s,]+/u).map(Number)
      if (viewBox?.length === 4 && viewBox[2]! > 0 && viewBox[3]! > 0) {
        image.setAttribute('width', String(viewBox[2]))
        image.setAttribute('height', String(viewBox[3]))
      }
      // Mermaid 的阶梯插值会重复端点；Chromium 会把零长度末段的箭头转为朝右。
      // 仅移除直角折线中连续重合的点，保留路径几何与用户指定的其它曲线。
      for (const edge of image.querySelectorAll('.flowchart-link')) {
        const data = edge.getAttribute('d') ?? ''
        if (!/^M-?[\d.]+,-?[\d.]+(?:L-?[\d.]+,-?[\d.]+)+$/u.test(data)) continue
        let previous = ''
        edge.setAttribute('d', data.replace(/[ML](-?[\d.]+,-?[\d.]+)/gu, (segment: string, point: string) => {
          const duplicate = point === previous
          previous = point
          return duplicate ? '' : segment
        }))
      }
      image.setAttribute('style', `${image.getAttribute('style') ?? ''}; background: white;`)
      return new XMLSerializer().serializeToString(image)
    } finally {
      container.remove()
    }
  })
  queue = task.then(() => undefined, () => undefined)
  return task
}
