import type { MermaidConfig } from 'mermaid'

const MERMAID_MAX_SOURCE_CHARS = 20_000
const MERMAID_MAX_LINES = 500
const MERMAID_MAX_EDGES = 200

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
    const config: MermaidConfig = {
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      maxTextSize: MERMAID_MAX_SOURCE_CHARS,
      maxEdges: MERMAID_MAX_EDGES,
      // 图片展示不支持 foreignObject；使用 SVG 原生文字以支持缩放与导出。
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'],
      theme: 'base',
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--wc-font-family').trim(),
      themeVariables: {
        background: '#ffffff', primaryColor: '#f1f3f4', primaryTextColor: '#30322d',
        primaryBorderColor: '#aab4bd', lineColor: '#777c73', secondaryColor: '#e6edf2',
        tertiaryColor: '#f8f8f6', noteBkgColor: '#f8f8f6', noteTextColor: '#30322d',
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
      image.setAttribute('style', `${image.getAttribute('style') ?? ''}; background: white;`)
      return new XMLSerializer().serializeToString(image)
    } finally {
      container.remove()
    }
  })
  queue = task.then(() => undefined, () => undefined)
  return task
}
