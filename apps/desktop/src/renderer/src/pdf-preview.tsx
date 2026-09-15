import { getDocument, PDFWorker, type PDFDocumentProxy } from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'
import { useEffect, useRef, useState, type RefObject } from 'react'
import { FilePreviewMessage } from './file-preview-controls.tsx'

type AssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'
declare const __WHYCODE_PDF_ASSETS__: Record<AssetKind, Record<string, string>>

class PdfAssets {
  async fetch({ kind, filename }: { kind: AssetKind; filename: string }): Promise<Uint8Array> {
    const files = __WHYCODE_PDF_ASSETS__[kind]
    const encoded = files?.[filename]
    if (!files || !Object.hasOwn(files, filename) || !encoded) throw new Error('PDF 所需字体或解码资源不可用')
    return Uint8Array.from(atob(encoded), char => char.charCodeAt(0))
  }
}

export default function PdfPreview({ url }: { url: string }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    const abort = new AbortController()
    let worker: Worker | undefined
    let workerUrl: string | undefined
    let bridge: PDFWorker | undefined
    let loading: ReturnType<typeof getDocument> | undefined
    let stopped = false
    let signalFailure!: () => void
    const broken = new Promise<void>(resolve => { signalFailure = resolve })
    const dispose = () => {
      if (stopped) return
      stopped = true
      abort.abort()
      void Promise.race([loading?.destroy(), broken]).catch(() => {}).finally(() => {
        bridge?.destroy()
        worker?.terminate()
        if (workerUrl) URL.revokeObjectURL(workerUrl)
      })
    }
    const fail = (cause: unknown) => {
      signalFailure()
      if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'PDF 工作线程无法运行')
      dispose()
    }
    setDocument(null)
    setError(null)
    void (async () => {
      const response = await fetch(url, { signal: abort.signal })
      if (!response.ok) throw new Error('PDF 已移动或无法读取，请刷新后重试')
      const data = new Uint8Array(await response.arrayBuffer())
      abort.signal.throwIfAborted()
      workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
      worker = new Worker(workerUrl, { type: 'module', name: 'whycode-pdf-preview' })
      worker.onerror = fail
      worker.onmessageerror = fail
      bridge = PDFWorker.create({ port: worker })
      loading = getDocument({ data, worker: bridge, BinaryDataFactory: PdfAssets, cMapPacked: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true })
      const result = await loading.promise
      if (!abort.signal.aborted) setDocument(result)
    })().catch(error => { if (!abort.signal.aborted) fail(error) })
    return dispose
  }, [url])
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
    const visibility = new IntersectionObserver(entries => setVisible(entries[0]?.isIntersecting ?? false), { root: scrollRef.current, rootMargin: '600px 0px' })
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
      if (!active) return
      const original = page.getViewport({ scale: 1 })
      setRatio(original.height / original.width)
      const scale = Math.min(window.devicePixelRatio || 1, 2, 4096 / width)
      const viewport = page.getViewport({ scale: width / original.width * scale })
      target.width = Math.ceil(viewport.width)
      target.height = Math.ceil(viewport.height)
      render = page.render({ canvas: target, viewport })
      await render.promise
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
