import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import {
  PDF_ATTACHMENT_MAX_PAGES,
  PDF_ATTACHMENT_MAX_SOURCE_BYTES,
  PDF_TEXT_MAX_CHARS,
  PDF_TEXT_MAX_PAGES,
  PDF_VISUAL_MAX_BYTES,
  PDF_VISUAL_MAX_PAGES,
  PdfProcessingError,
  type PdfDocumentInfo,
  type PdfPageReadOptions,
  type PdfPageReadResult,
  type PdfRenderedPage,
} from '@whycode/core/pdf'
import {
  PDF_WEB_DOCUMENT_MAX_TEXT_CHARS,
  type PdfWebDocumentResult,
  type PdfWorkerRequest,
  type PdfWorkerResult,
} from './protocol.ts'

const PDF_RENDER_MAX_DIMENSION = 2_048
const PDF_RENDER_MAX_PIXELS = 20_000_000
const PDF_RENDER_MAX_BYTES = 20_000_000
/** Claude Code 的分页提取路径使用 pdftoppm -jpeg -r 100。 */
const PDF_RENDER_DPI = 100
/** pdftoppm/libjpeg 未显式指定质量时采用的通用默认值。 */
const PDF_RENDER_JPEG_QUALITY = 75

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type PdfDocument = Awaited<ReturnType<PdfJs['getDocument']>['promise']>

let pdfJsPromise: Promise<PdfJs> | null = null

export async function executePdfWorkerRequest(request: PdfWorkerRequest): Promise<PdfWorkerResult> {
  if (request.operation === 'inspect') return inspectPdf(request.path)
  if (request.operation === 'read-web-document') return readPdfForWeb(request.path)
  return readPdfPages(request.path, request.options)
}

export async function inspectPdf(path: string): Promise<PdfDocumentInfo> {
  return withPdf(path, async (document, byteLength) => ({
    pageCount: document.numPages,
    byteLength,
  }))
}

export async function readPdfPages(
  path: string,
  options: PdfPageReadOptions,
): Promise<PdfPageReadResult> {
  validateReadOptions(options)
  return withPdf(path, async (document) => {
    if (options.startPage > document.numPages) {
      throw new PdfProcessingError(
        'invalid-page-range',
        `起始页 ${options.startPage} 超出 PDF 总页数 ${document.numPages}`,
      )
    }
    const lastPage = Math.min(document.numPages, options.startPage + options.pageCount - 1)
    if (options.mode === 'visual') {
      await mkdir(resolve(options.outputDirectory), { recursive: true })
    }

    if (options.mode === 'text') {
      const pages = []
      for (let pageNumber = options.startPage; pageNumber <= lastPage; pageNumber += 1) {
        const page = await document.getPage(pageNumber)
        try {
          const textContent = await page.getTextContent()
          pages.push({
            pageNumber,
            // IPC 前先按单页封顶；Core 随后再对整批页面公平分配 60k 输出预算。
            text: normalizePageText(textContent.items).slice(0, PDF_TEXT_MAX_CHARS),
          })
        } finally {
          page.cleanup()
        }
      }
      return { mode: 'text', pageCount: document.numPages, pages }
    }

    const renderedPages: PdfRenderedPage[] = []
    let totalRenderedBytes = 0
    for (let pageNumber = options.startPage; pageNumber <= lastPage; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const rendered = await renderPage(page, pageNumber, options.outputDirectory)
        totalRenderedBytes += rendered.byteLength
        if (totalRenderedBytes > PDF_VISUAL_MAX_BYTES) {
          throw new PdfProcessingError(
            'too-large',
            'PDF 页面图超过单次读取字节预算，请缩小页数后重试',
          )
        }
        renderedPages.push(rendered.page)
      } finally {
        page.cleanup()
      }
    }
    return { mode: 'visual', pageCount: document.numPages, renderedPages }
  }, options.expectedSha256)
}

export async function readPdfForWeb(path: string): Promise<PdfWebDocumentResult> {
  return withPdf(path, async (document) => {
    const pages = []
    let textChars = 0
    let sourceTruncated = false
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const textContent = await page.getTextContent()
        const text = normalizePageText(textContent.items)
        const remaining = PDF_WEB_DOCUMENT_MAX_TEXT_CHARS - textChars
        if (text.length > remaining) {
          pages.push({ pageNumber, text: text.slice(0, Math.max(0, remaining)) })
          sourceTruncated = true
          break
        }
        pages.push({ pageNumber, text })
        textChars += text.length
        if (textChars === PDF_WEB_DOCUMENT_MAX_TEXT_CHARS && pageNumber < document.numPages) {
          sourceTruncated = true
          break
        }
      } finally {
        page.cleanup()
      }
    }
    return { mode: 'web-text', pageCount: document.numPages, pages, sourceTruncated }
  })
}

async function withPdf<T>(
  path: string,
  action: (document: PdfDocument, byteLength: number) => Promise<T>,
  expectedSha256?: string,
): Promise<T> {
  const bytes = await readPdfBytes(path)
  if (
    expectedSha256
    && createHash('sha256').update(bytes).digest('hex') !== expectedSha256
  ) {
    throw new PdfProcessingError('corrupted', `PDF 附件内容已发生变化：${basename(path)}`)
  }
  const pdfjs = await loadPdfJs()
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    maxImageSize: PDF_RENDER_MAX_PIXELS,
    canvasMaxAreaInBytes: PDF_RENDER_MAX_PIXELS * 4,
    isImageDecoderSupported: false,
    isOffscreenCanvasSupported: false,
    useWorkerFetch: false,
    useSystemFonts: true,
    cMapPacked: true,
    ...pdfAssetUrls(),
  })
  let document: PdfDocument | null = null
  try {
    document = await loadingTask.promise
    if (document.numPages <= 0 || document.numPages > PDF_ATTACHMENT_MAX_PAGES) {
      throw new PdfProcessingError(
        'too-many-pages',
        `PDF 页数必须在 1-${PDF_ATTACHMENT_MAX_PAGES} 页之间`,
      )
    }
    return await action(document, bytes.byteLength)
  } catch (error) {
    throw normalizePdfError(error, basename(path))
  } finally {
    await document?.cleanup().catch(() => {})
    await loadingTask.destroy().catch(() => {})
  }
}

async function readPdfBytes(path: string): Promise<Buffer> {
  let info
  try {
    info = await stat(resolve(path))
  } catch (error) {
    throw new PdfProcessingError('unavailable', `无法读取 PDF：${basename(path)}`, { cause: error })
  }
  if (!info.isFile()) throw new PdfProcessingError('corrupted', 'PDF 来源不是普通文件')
  if (info.size <= 0) throw new PdfProcessingError('empty', 'PDF 文件为空')
  if (info.size > PDF_ATTACHMENT_MAX_SOURCE_BYTES) {
    throw new PdfProcessingError('too-large', 'PDF 文件超过 50 MB 上限')
  }
  const bytes = await readFile(resolve(path))
  if (bytes.byteLength > PDF_ATTACHMENT_MAX_SOURCE_BYTES) {
    throw new PdfProcessingError('too-large', 'PDF 文件超过 50 MB 上限')
  }
  if (bytes.byteLength !== info.size) {
    throw new PdfProcessingError('unavailable', `读取 PDF 时文件发生变化：${basename(path)}`)
  }
  if (!bytes.subarray(0, 1_024).includes(Buffer.from('%PDF-'))) {
    throw new PdfProcessingError('corrupted', '文件缺少有效 PDF 文件头')
  }
  return bytes
}

function validateReadOptions(options: PdfPageReadOptions): void {
  if (!Number.isInteger(options.startPage) || options.startPage < 1) {
    throw new PdfProcessingError('invalid-page-range', 'PDF 起始页必须是正整数')
  }
  const maxPages = options.mode === 'visual' ? PDF_VISUAL_MAX_PAGES : PDF_TEXT_MAX_PAGES
  if (!Number.isInteger(options.pageCount) || options.pageCount < 1 || options.pageCount > maxPages) {
    throw new PdfProcessingError(
      'invalid-page-range',
      `本次最多读取 ${maxPages} 页 PDF`,
    )
  }
  if (options.expectedSha256 && !/^[0-9a-f]{64}$/.test(options.expectedSha256)) {
    throw new PdfProcessingError('unknown', 'PDF 内容摘要格式无效')
  }
}

async function renderPage(
  page: Awaited<ReturnType<PdfDocument['getPage']>>,
  pageNumber: number,
  outputDirectory: string,
): Promise<{ page: PdfRenderedPage; byteLength: number }> {
  const { createCanvas } = await import('@napi-rs/canvas')
  const original = page.getViewport({ scale: 1 })
  assertFinitePageSize(original.width, original.height)
  const originalPixels = original.width * original.height
  const scale = Math.min(
    PDF_RENDER_DPI / 72,
    (PDF_RENDER_MAX_DIMENSION - 1) / Math.max(original.width, original.height),
    Math.sqrt((PDF_RENDER_MAX_PIXELS - 2 * PDF_RENDER_MAX_DIMENSION) / originalPixels),
  )
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new PdfProcessingError('too-large', `PDF 第 ${pageNumber} 页尺寸超过渲染上限`)
  }
  const viewport = page.getViewport({ scale })
  const width = Math.ceil(viewport.width)
  const height = Math.ceil(viewport.height)
  assertFinitePageSize(width, height)
  if (width * height > PDF_RENDER_MAX_PIXELS) {
    throw new PdfProcessingError('too-large', `PDF 第 ${pageNumber} 页渲染像素超过上限`)
  }

  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise
  const jpeg = canvas.encodeSync('jpeg', PDF_RENDER_JPEG_QUALITY)
  if (jpeg.byteLength > PDF_RENDER_MAX_BYTES) {
    throw new PdfProcessingError('too-large', `PDF 第 ${pageNumber} 页渲染结果超过上限`)
  }
  const outputPath = join(resolve(outputDirectory), `page-${String(pageNumber).padStart(4, '0')}.jpg`)
  await writeFile(outputPath, jpeg, { flag: 'wx' })
  return {
    page: { pageNumber, path: outputPath, width, height },
    byteLength: jpeg.byteLength,
  }
}

function normalizePageText(items: unknown[]): string {
  const chunks: string[] = []
  for (const item of items) {
    if (!isTextItem(item) || item.str.length === 0) continue
    chunks.push(item.str.replaceAll('\u0000', ''))
    chunks.push(item.hasEOL ? '\n' : ' ')
  }
  return chunks.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function isTextItem(value: unknown): value is { str: string; hasEOL: boolean } {
  return typeof value === 'object'
    && value !== null
    && 'str' in value
    && typeof value.str === 'string'
    && 'hasEOL' in value
    && typeof value.hasEOL === 'boolean'
}

function assertFinitePageSize(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new PdfProcessingError('corrupted', 'PDF 页面尺寸无效')
  }
}

function normalizePdfError(error: unknown, name: string): PdfProcessingError {
  if (error instanceof PdfProcessingError) return error
  const errorName = error instanceof Error ? error.name : ''
  if (errorName === 'PasswordException') {
    return new PdfProcessingError('password-protected', `PDF 已加密：${name}`)
  }
  if (['InvalidPDFException', 'FormatError', 'UnknownErrorException'].includes(errorName)) {
    return new PdfProcessingError('corrupted', `PDF 已损坏或格式无效：${name}`, { cause: error })
  }
  return new PdfProcessingError('unknown', `PDF 处理失败：${name}`, { cause: error })
}

function loadPdfJs(): Promise<PdfJs> {
  pdfJsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfAssetPath('legacy/build/pdf.worker.mjs', true)
    return pdfjs
  })
  return pdfJsPromise
}

function pdfAssetUrls(): {
  cMapUrl: string
  standardFontDataUrl: string
  wasmUrl: string
  iccUrl: string
} {
  return {
    cMapUrl: pdfAssetPath('cmaps'),
    standardFontDataUrl: pdfAssetPath('standard_fonts'),
    wasmUrl: pdfAssetPath('wasm'),
    iccUrl: pdfAssetPath('iccs'),
  }
}

function pdfAssetPath(relativePath: string, asFileUrl = false): string {
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('pdfjs-dist/package.json'))
  const path = join(root, relativePath)
  if (asFileUrl) return pathToFileURL(path).href
  return `${path.replaceAll('\\', '/').replace(/\/$/, '')}/`
}
