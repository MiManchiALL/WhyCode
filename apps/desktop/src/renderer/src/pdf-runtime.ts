import { getDocument, PDFDataRangeTransport, PDFWorker } from 'pdfjs-dist'
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

// 资源独立输出；只为实际用到的字体、字符映射和解码器读取二进制。
const assetUrls = import.meta.glob<string>('../../../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*.{bcmap,pfb,ttf,wasm}', {
  eager: true, query: '?url&no-inline', import: 'default',
})
const directories = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' }

async function readPdfAsset({ kind, filename }: { kind: keyof typeof directories; filename: string }, signal: AbortSignal): Promise<Uint8Array> {
  const key = `../../../node_modules/pdfjs-dist/${directories[kind]}/${filename}`
  const url = Object.hasOwn(assetUrls, key) ? assetUrls[key] : undefined
  if (!url) throw new Error('PDF 所需字体或解码资源不可用')
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error('PDF 所需字体或解码资源无法读取')
  return new Uint8Array(await response.arrayBuffer())
}

// PDF.js 的默认网络读取器只对 HTTP 启用范围请求；本地协议直接提供按需分块。
class PdfRange extends PDFDataRangeTransport {
  private readonly lifetime = new AbortController()
  private readonly url: string
  private readonly fail: (error: unknown) => void
  constructor(url: string, size: number, fail: (error: unknown) => void) {
    super(size, null)
    this.url = url
    this.fail = fail
  }
  override requestDataRange(begin: number, end: number): void {
    void (async () => {
      const response = await fetch(this.url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal: this.lifetime.signal })
      if (response.status !== 206) throw new Error('PDF 已移动或无法读取，请刷新后重试')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length !== end - begin) throw new Error('PDF 已发生变化，请刷新后重试')
      if (!this.lifetime.signal.aborted) this.onDataRange(begin, bytes)
    })().catch(error => { if (!this.lifetime.signal.aborted) this.fail(error) })
  }
  override abort(): void { this.lifetime.abort() }
}

export function openPdf(url: string, size: number, reportFailure: (error: unknown) => void) {
  let worker: Worker | undefined
  let bridge: PDFWorker | undefined
  let loading: ReturnType<typeof getDocument> | undefined
  let range: PdfRange | undefined
  let stopped = false
  const lifetime = new AbortController()
  let rejectFailure!: (error: unknown) => void
  const failed = new Promise<never>((_resolve, reject) => { rejectFailure = reject })
  let signalFailure!: () => void
  const broken = new Promise<void>(resolve => { signalFailure = resolve })
  const dispose = () => {
    if (stopped) return
    stopped = true
    lifetime.abort()
    rejectFailure(new DOMException('PDF 预览已关闭', 'AbortError'))
    range?.abort()
    void Promise.race([loading?.destroy(), broken]).catch(() => {}).finally(() => {
      bridge?.destroy()
      worker?.terminate()
    })
  }
  const fail = (cause: unknown) => {
    signalFailure()
    rejectFailure(cause)
    if (!stopped) reportFailure(cause)
    dispose()
  }
  const initialize = async () => {
    worker = new PdfWorker({ name: 'whycode-pdf-preview' })
    worker.onerror = fail
    worker.onmessageerror = fail
    bridge = PDFWorker.create({ port: worker })
    range = new PdfRange(url, size, fail)
    loading = getDocument({
      range, worker: bridge, disableAutoFetch: true,
      BinaryDataFactory: class {
        fetch(request: Parameters<typeof readPdfAsset>[0]) { return readPdfAsset(request, lifetime.signal) }
      },
      cMapPacked: true, useWorkerFetch: false, canvasMaxAreaInBytes: 16_777_216,
      enableXfa: false, stopAtErrors: true,
    })
    return loading.promise
  }
  const document = Promise.race([initialize(), failed]).catch(cause => { if (!stopped) fail(cause); throw cause })
  return { document, dispose }
}
