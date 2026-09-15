import type { PDFDocumentProxy } from 'pdfjs-dist'
import { openPdf } from './pdf-runtime.ts'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { FilePreviewMessage } from './file-preview-controls.tsx'

export default function PdfPreview({ url, size }: { url: string; size: number }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setDocument(null)
    setError(null)
    const session = openPdf(url, size, cause => {
      if (active) setError(cause instanceof Error ? cause.message : 'PDF 工作线程无法运行')
    })
    void session.document.then(result => { if (active) setDocument(result) }).catch(() => {})
    return () => { active = false; session.dispose() }
  }, [url, size])
  if (error) return <FilePreviewMessage>{error}</FilePreviewMessage>
  if (!document) return <FilePreviewMessage>正在读取 PDF…</FilePreviewMessage>
  return <div ref={scrollRef} className="wc-pdf-preview wc-scrollbar min-h-0 flex-1 overflow-y-auto bg-black/[0.035] px-3 py-3" aria-label={`PDF，共 ${document.numPages} 页`}>
    {Array.from({ length: document.numPages }, (_, index) => <PdfPage key={index} document={document} pageNumber={index + 1} scrollRef={scrollRef} />)}
  </div>
}

function PdfPage({ document, pageNumber, scrollRef }: { document: PDFDocumentProxy; pageNumber: number; scrollRef: RefObject<HTMLDivElement | null> }) {
  const host = useRef<HTMLDivElement>(null)
  const canvasHost = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [width, setWidth] = useState(0)
  const [ratio, setRatio] = useState(Math.SQRT2)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const element = host.current
    if (!element) return
    const visibility = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false), { root: scrollRef.current, rootMargin: '300px 0px' })
    const resize = new ResizeObserver(entries => setWidth(Math.floor(entries[0]?.contentRect.width ?? 0)))
    visibility.observe(element)
    resize.observe(element)
    return () => { visibility.disconnect(); resize.disconnect() }
  }, [scrollRef])
  useEffect(() => {
    const element = canvasHost.current
    if (!visible || width <= 0 || !element) return
    const target = element.ownerDocument.createElement('canvas')
    target.className = 'block h-full w-full'
    element.append(target)
    setError(null)
    let active = true
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined
    const rendering = (async () => {
      const page = await document.getPage(pageNumber)
      try {
        if (!active) return
        const original = page.getViewport({ scale: 1 })
        const height = width * original.height / original.width
        setRatio(original.height / original.width)
        // 同时限制面积和长边，避免全屏或超长页面分配巨型位图。
        const scale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(4_194_304 / (width * height)), 4096 / Math.max(width, height))
        const viewport = page.getViewport({ scale: width / original.width * scale })
        target.width = Math.max(1, Math.floor(viewport.width))
        target.height = Math.max(1, Math.floor(viewport.height))
        render = page.render({ canvas: target, viewport })
        await render.promise
        render = undefined
      } finally { page.cleanup() }
    })().catch(error => {
      if (active) setError(error instanceof Error ? error.message : '页面无法渲染')
    })
    return () => {
      active = false
      render?.cancel()
      target.remove()
      void rendering.finally(() => { target.width = 0; target.height = 0 })
    }
  }, [document, pageNumber, visible, width])
  return <div className="mb-3" aria-label={`第 ${pageNumber} 页`}>
    <div ref={host} className="relative w-full overflow-hidden bg-white shadow-sm" style={{ aspectRatio: `1 / ${ratio}` }}>
      <div ref={canvasHost} className="absolute inset-0" />
      {error && <div className="absolute inset-0 flex items-center justify-center p-4 text-xs text-[var(--wc-muted)]">{error}</div>}
    </div>
    <div className="pt-1 text-center text-xs text-[var(--wc-faint)]">{pageNumber} / {document.numPages}</div>
  </div>
}
