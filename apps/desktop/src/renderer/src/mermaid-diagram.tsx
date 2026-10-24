import { useEffect, useState, type ReactNode } from 'react'
import { Maximize2 } from 'lucide-react'
import { FadedScrollArea } from './faded-scroll-area.tsx'
import { ImagePreviewDialog } from './image-preview.tsx'
import { mermaidSourceTooLarge, renderMermaid } from './mermaid-rendering.ts'

export function MermaidDiagram({ code, visible, source, actions, wrapAction }: {
  code: string; visible: boolean; source: ReactNode; actions: ReactNode; wrapAction: ReactNode
}) {
  const [result, setResult] = useState<{ svg: string } | { error: string } | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [showSource, setShowSource] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const tooLarge = mermaidSourceTooLarge(code)
  useEffect(() => {
    if (!visible || result || tooLarge) return
    const controller = new AbortController()
    void renderMermaid(code, controller.signal).then(svg => {
      if (!controller.signal.aborted) setResult({ svg })
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ error: error instanceof Error ? error.message : String(error) })
    })
    return () => controller.abort()
  }, [code, visible, result, tooLarge])
  const svg = result && 'svg' in result ? result.svg : null
  useEffect(() => {
    if (!svg) return
    const objectUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [svg])
  const error = result && 'error' in result ? result.error : null
  return <>
    <div className="wc-fence-toolbar">
      <span className="min-w-0 flex-1 truncate" role="status" title={error ?? undefined}>
        {tooLarge ? '图表过大，已显示源码' : error ? '图表无法渲染，已显示源码' : !url ? '正在准备图表…' : 'Mermaid'}
      </span>
      {url && <>
        <button type="button" className="wc-focus-ring rounded px-2 py-1 hover:bg-black/5" aria-pressed={showSource}
          onClick={() => setShowSource(value => !value)}>{showSource ? '图表' : '源码'}</button>
        <button type="button" className="wc-icon-button size-7" title="放大图表" aria-label="放大图表" onClick={() => setPreview('diagram')}><Maximize2 size={14} /></button>
      </>}
      {(!url || showSource) && wrapAction}
      {actions}
    </div>
    {url && !showSource ? <FadedScrollArea className="wc-mermaid-viewport wc-scrollbar">
      <button type="button" className="wc-mermaid-image wc-focus-ring" aria-label="放大 Mermaid 图表" onClick={() => setPreview('diagram')}>
        <img src={url} alt="Mermaid 图表" decoding="async" />
      </button>
    </FadedScrollArea> : source}
    {url && <ImagePreviewDialog targets={[{ id: 'diagram', src: url, name: 'Mermaid 图表' }]} selectedId={preview} onSelect={setPreview} />}
  </>
}
